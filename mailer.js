"use strict";

/* =========================================================================
   Minimaler SMTP-Client - reine Node.js-Bordmittel (net/tls), keine
   Zusatzpakete. Genuegt fuer einfache Transaktionsmails (Passwort-Reset).

   Konfiguration ueber Umgebungsvariablen, nach demselben Muster wie
   KOCHBUCH_DB in server.js:
     SMTP_HOST    Server, z.B. smtp.example.com (leer = kein Mailversand)
     SMTP_PORT    Port, Standard 587 (STARTTLS) oder 465 (direktes TLS)
     SMTP_SECURE  "true" fuer direktes TLS (Port 465), sonst STARTTLS
     SMTP_USER    Benutzername fuer AUTH LOGIN
     SMTP_PASS    Passwort dazu
     SMTP_FROM    Absenderadresse, Standard: SMTP_USER

   Ist SMTP_HOST nicht gesetzt, wird NICHT verschickt - stattdessen landet
   der Inhalt (inkl. Reset-Link) lesbar im Server-Log. So bleibt die
   Funktion ohne Mail-Server sofort testbar, nur eben nicht als echte Mail.
   ========================================================================= */

const net = require("node:net");
const tls = require("node:tls");

function isConfigured() {
  return Boolean(process.env.SMTP_HOST);
}

/** Base64 in MIME-Zeilen von hoechstens 76 Zeichen - Standard fuer E-Mail-Bodies. */
function wrapBase64(buf) {
  const full = buf.toString("base64");
  const lines = [];
  for (let i = 0; i < full.length; i += 76) lines.push(full.slice(i, i + 76));
  return lines.join("\r\n");
}

/** RFC-2047-Kodierung fuer nicht-ASCII-Betreffzeilen (Umlaute etc.). */
function encodeSubject(subject) {
  if (/^[\x00-\x7F]*$/.test(subject)) return subject;
  return `=?UTF-8?B?${Buffer.from(subject, "utf8").toString("base64")}?=`;
}

/** Liest SMTP-Antworten zeilenweise und erkennt das Ende mehrzeiliger Antworten ("250-..." vs. "250 ..."). */
function readResponse(socket) {
  return new Promise((resolve, reject) => {
    let buf = "";
    const onData = (chunk) => {
      buf += chunk.toString("utf8");
      const lines = buf.split("\r\n").filter(Boolean);
      const last = lines[lines.length - 1];
      if (last && /^\d{3} /.test(last)) {
        cleanup();
        const code = Number(last.slice(0, 3));
        resolve({ code, text: lines.join("\n") });
      }
    };
    const onError = (err) => { cleanup(); reject(err); };
    const onClose = () => { cleanup(); reject(new Error("SMTP-Verbindung wurde geschlossen.")); };
    function cleanup() {
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("close", onClose);
    }
    socket.on("data", onData);
    socket.on("error", onError);
    socket.on("close", onClose);
  });
}

function writeCommand(socket, line) {
  socket.write(line + "\r\n");
}

/** Schickt einen Befehl und wirft, wenn die Antwort nicht mit dem erwarteten Code beginnt. */
async function command(socket, line, expectedCode, step) {
  if (line !== null) writeCommand(socket, line);
  const res = await readResponse(socket);
  if (Math.floor(res.code / 100) !== Math.floor(expectedCode / 100)) {
    throw new Error(`SMTP-Fehler bei ${step}: ${res.text}`);
  }
  return res;
}

/**
 * Verschickt eine einfache Text-Mail. Liefert immer ein Ergebnisobjekt statt
 * zu werfen - ein Mailproblem soll den auslösenden API-Aufruf (z.B.
 * Passwort-Reset) nicht mit 500 abbrechen lassen.
 */
async function sendMail({ to, subject, text }) {
  if (!isConfigured()) {
    console.log(`[mailer] Kein SMTP_HOST konfiguriert - Mail wird nur geloggt:\n  An: ${to}\n  Betreff: ${subject}\n  ${text.replace(/\n/g, "\n  ")}`);
    return { delivered: false, loggedOnly: true };
  }

  const host = process.env.SMTP_HOST;
  const port = Number(process.env.SMTP_PORT) || (process.env.SMTP_SECURE === "true" ? 465 : 587);
  const secure = process.env.SMTP_SECURE === "true" || port === 465;
  const user = process.env.SMTP_USER || "";
  const pass = process.env.SMTP_PASS || "";
  const from = process.env.SMTP_FROM || user;

  let socket;
  try {
    socket = secure
      ? tls.connect({ host, port, servername: host })
      : net.connect({ host, port });
    await new Promise((resolve, reject) => {
      socket.once(secure ? "secureConnect" : "connect", resolve);
      socket.once("error", reject);
    });

    await command(socket, null, 220, "Begruessung");
    await command(socket, `EHLO kochbuch`, 250, "EHLO");

    if (!secure) {
      await command(socket, "STARTTLS", 220, "STARTTLS");
      const plainSocket = socket;
      socket = await new Promise((resolve, reject) => {
        const upgraded = tls.connect({ socket: plainSocket, servername: host }, () => resolve(upgraded));
        upgraded.once("error", reject);
      });
      await command(socket, `EHLO kochbuch`, 250, "EHLO nach STARTTLS");
    }

    if (user) {
      await command(socket, "AUTH LOGIN", 334, "AUTH LOGIN");
      await command(socket, Buffer.from(user, "utf8").toString("base64"), 334, "Benutzername");
      await command(socket, Buffer.from(pass, "utf8").toString("base64"), 235, "Passwort");
    }

    await command(socket, `MAIL FROM:<${from}>`, 250, "MAIL FROM");
    await command(socket, `RCPT TO:<${to}>`, 250, "RCPT TO");
    await command(socket, "DATA", 354, "DATA");

    const headers = [
      `From: ${from}`,
      `To: ${to}`,
      `Subject: ${encodeSubject(subject)}`,
      `MIME-Version: 1.0`,
      `Content-Type: text/plain; charset=UTF-8`,
      `Content-Transfer-Encoding: base64`,
      ``,
    ].join("\r\n");
    // Base64-Koerper: keine Zeile kann zufaellig nur aus "." bestehen, daher
    // ist hier kein Dot-Stuffing noetig (anders als bei rohem Text-Body).
    writeCommand(socket, headers + wrapBase64(Buffer.from(text, "utf8")) + "\r\n.");
    await readResponse(socket).then((res) => {
      if (Math.floor(res.code / 100) !== 2) throw new Error(`SMTP-Fehler beim Senden: ${res.text}`);
    });

    await command(socket, "QUIT", 221, "QUIT");
    socket.end();
    return { delivered: true };
  } catch (err) {
    console.error("[mailer] Mailversand fehlgeschlagen:", err.message);
    if (socket) socket.destroy();
    return { delivered: false, error: err.message };
  }
}

module.exports = { sendMail, isConfigured };
