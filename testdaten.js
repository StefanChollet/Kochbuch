"use strict";

/*
  Testdaten fuer das Kochbuch.

  Legt 100 Rezepte (mit Kategorie, Zutaten, Zubereitungstext und Bildern) und
  20 Testbenutzer an. Die Rezepte verteilen sich auf den Admin und die
  Benutzer mit Schreibrecht, Zeitstempel liegen ueber das letzte Jahr verteilt.
  Damit sind Uebersicht (Suche, Sortierung, Paging, Miniaturen), Detaildialog
  und Benutzerverwaltung (Rezeptzahl je Benutzer) sinnvoll gefuellt.

  Aufruf (Server vorher mit Strg+C beenden):
    node testdaten.js                 Testdaten anlegen (vorhandene Testdaten werden ersetzt)
    node testdaten.js --entfernen     nur die Testdaten wieder entfernen
    node testdaten.js --rezepte 300 --benutzer 50   andere Mengen

  Echte Daten bleiben unberuehrt: Testrezepte haben ids mit "test-",
  Testbenutzer werden in der Tabelle meta (testdata_accounts) vermerkt.
  Datenbank wie beim Server: kochbuch.sqlite oder KOCHBUCH_DB.
*/

const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const db = require("./db");

const DB_FILE = process.env.KOCHBUCH_DB
  ? path.resolve(process.env.KOCHBUCH_DB)
  : path.join(__dirname, "kochbuch.sqlite");

const ID_PREFIX = "test-";
const META_KEY = "testdata_accounts";
const TEST_PASSWORD = "test1234";

/* ------------------------------------------------------------ Argumente */

const args = process.argv.slice(2);
function numberArg(name, fallback) {
  const i = args.indexOf(name);
  if (i === -1) return fallback;
  const n = Math.trunc(Number(args[i + 1]));
  if (!(n >= 0)) {
    console.error(`${name} braucht eine Zahl.`);
    process.exit(1);
  }
  return n;
}
const REMOVE_ONLY = args.includes("--entfernen");
const RECIPE_COUNT = numberArg("--rezepte", 100);
const USER_COUNT = numberArg("--benutzer", 20);

/* -------------------------------------------------- Zufall (reproduzierbar) */

// Fester Startwert: jeder Lauf erzeugt denselben Bestand.
let seed = 20261018;
function rand() {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 4294967296;
}
const pick = (list) => list[Math.floor(rand() * list.length)];
const between = (min, max) => min + Math.floor(rand() * (max - min + 1));

/* ------------------------------------------------------------ Rezepte */

// [Name, Kategorie, Kurzbeschreibung, "Zutat:Menge|Zutat:Menge|..."]
const RECIPES = [
  // Suppe
  ["Kürbissuppe mit Ingwer", "Suppe", "Cremig, leicht scharf, mit Kokosmilch", "Hokkaido-Kürbis:1 kg|Zwiebel:1|Ingwer:20 g|Kokosmilch:400 ml|Gemüsebrühe:500 ml|Kürbiskerne:2 EL"],
  ["Bündner Gerstensuppe", "Suppe", "Wärmender Klassiker aus Graubünden", "Rollgerste:100 g|Bündnerfleisch:80 g|Lauch:1|Karotten:2|Knollensellerie:100 g|Rahm:1 dl|Gemüsebrühe:1.5 l"],
  ["Minestrone", "Suppe", "Italienische Gemüsesuppe mit Pasta", "Zucchetti:1|Karotten:2|Stangensellerie:2|Weisse Bohnen:1 Dose|Tomaten gehackt:400 g|Ditalini:80 g|Parmesan:40 g"],
  ["Linsensuppe mit Speck", "Suppe", "Deftig und sättigend", "Braune Linsen:250 g|Speckwürfel:100 g|Kartoffeln:2|Karotten:2|Zwiebel:1|Essig:1 EL"],
  ["Tomatensuppe", "Suppe", "Aus Ofentomaten, mit Basilikum", "Tomaten:1 kg|Knoblauch:3 Zehen|Zwiebel:1|Olivenöl:3 EL|Basilikum:1 Bund|Gemüsebrühe:3 dl"],
  ["Französische Zwiebelsuppe", "Suppe", "Mit überbackenem Käsebrot", "Zwiebeln:800 g|Butter:40 g|Weisswein:2 dl|Rinderbrühe:1 l|Baguette:4 Scheiben|Gruyère:100 g"],
  ["Kartoffel-Lauch-Suppe", "Suppe", "", "Kartoffeln:500 g|Lauch:2|Butter:20 g|Gemüsebrühe:1 l|Rahm:1 dl|Schnittlauch:1/2 Bund"],
  ["Thai-Kokossuppe mit Poulet", "Suppe", "Tom Kha Gai – säuerlich und aromatisch", "Pouletbrust:300 g|Kokosmilch:400 ml|Zitronengras:2 Stängel|Galgant:20 g|Champignons:150 g|Limette:1|Fischsauce:2 EL"],

  // Vorspeise & Salat
  ["Nüsslisalat mit Ei und Speck", "Vorspeise & Salat", "Wintersalat mit warmem Speck", "Nüsslisalat:200 g|Eier:2|Speckwürfel:80 g|Brotwürfel:50 g|Senf:1 TL|Weissweinessig:2 EL|Rapsöl:4 EL"],
  ["Griechischer Salat", "Vorspeise & Salat", "Mit Feta, Oliven und roten Zwiebeln", "Tomaten:4|Gurke:1|Feta:200 g|Kalamata-Oliven:80 g|Rote Zwiebel:1|Oregano:1 TL|Olivenöl:4 EL"],
  ["Caprese", "Vorspeise & Salat", "Tomate, Mozzarella, Basilikum", "Tomaten:4|Mozzarella:250 g|Basilikum:1 Bund|Olivenöl:3 EL|Balsamico:1 EL"],
  ["Wurstsalat mit Käse", "Vorspeise & Salat", "Schweizer Art, mit Essiggurken", "Cervelat:4|Emmentaler:150 g|Essiggurken:4|Zwiebel:1|Senf:1 TL|Essig:3 EL|Rapsöl:4 EL"],
  ["Rüeblisalat", "Vorspeise & Salat", "Frisch geraffelt mit Zitrone", "Karotten:500 g|Zitrone:1|Rapsöl:3 EL|Petersilie:1/2 Bund|Honig:1 TL"],
  ["Bruschetta", "Vorspeise & Salat", "Geröstetes Brot mit Tomaten", "Ciabatta:1|Tomaten:4|Knoblauch:2 Zehen|Basilikum:1/2 Bund|Olivenöl:4 EL"],
  ["Couscous-Salat", "Vorspeise & Salat", "Mit Minze, Granatapfel und Feta", "Couscous:200 g|Granatapfel:1|Minze:1 Bund|Feta:150 g|Gurke:1|Zitrone:1|Olivenöl:4 EL"],
  ["Randensalat mit Ziegenkäse", "Vorspeise & Salat", "Erdig, süss und cremig", "Randen gekocht:400 g|Ziegenfrischkäse:150 g|Baumnüsse:50 g|Honig:1 EL|Balsamico:2 EL|Rucola:80 g"],

  // Fleisch
  ["Zürcher Geschnetzeltes", "Fleisch", "Mit Champignons und Rahmsauce", "Kalbfleisch geschnetzelt:600 g|Champignons:250 g|Zwiebel:1|Weisswein:1 dl|Kalbsfond:1 dl|Rahm:2 dl|Butter:20 g"],
  ["Cordon bleu", "Fleisch", "Mit Schinken und Greyerzer gefüllt", "Schweinsschnitzel:4|Schinken:4 Tranchen|Gruyère:4 Scheiben|Eier:2|Paniermehl:100 g|Mehl:50 g|Bratbutter:40 g"],
  ["Rindsvoressen", "Fleisch", "Lange geschmort in Rotwein", "Rindsragout:1 kg|Rotwein:3 dl|Rindsbouillon:3 dl|Karotten:3|Zwiebeln:2|Tomatenpüree:2 EL|Lorbeerblatt:2"],
  ["Hackbraten", "Fleisch", "Saftig, mit Speckmantel", "Hackfleisch gemischt:800 g|Brötchen:1|Eier:2|Zwiebel:1|Senf:1 EL|Speckscheiben:8"],
  ["Pouletschenkel aus dem Ofen", "Fleisch", "Knusprig mit Paprika und Thymian", "Pouletschenkel:4|Paprika edelsüss:2 TL|Thymian:4 Zweige|Knoblauch:4 Zehen|Olivenöl:3 EL|Zitrone:1"],
  ["Wienerschnitzel", "Fleisch", "Dünn geklopft und in Butter gebraten", "Kalbsschnitzel:4|Eier:2|Mehl:50 g|Paniermehl:120 g|Bratbutter:80 g|Zitrone:1"],
  ["Chili con Carne", "Fleisch", "Mit Kidneybohnen und Mais", "Rindshackfleisch:500 g|Kidneybohnen:1 Dose|Mais:1 Dose|Tomaten gehackt:800 g|Peperoni rot:1|Chilipulver:1 TL|Kreuzkümmel:1 TL"],
  ["Schweinsfilet im Blätterteig", "Fleisch", "Festtagsbraten mit Pilzfarce", "Schweinsfilet:600 g|Blätterteig:1 Rolle|Champignons:250 g|Rohschinken:6 Tranchen|Ei:1|Petersilie:1/2 Bund"],
  ["Lammkarree mit Kräuterkruste", "Fleisch", "Rosa gebraten", "Lammkarree:2|Paniermehl:50 g|Petersilie:1 Bund|Rosmarin:2 Zweige|Knoblauch:2 Zehen|Senf:2 EL|Butter:40 g"],

  // Fisch
  ["Egli-Filets im Bierteig", "Fisch", "Knusprig, mit Tartarsauce", "Egli-Filets:500 g|Mehl:150 g|Bier:2 dl|Ei:1|Frittieröl:1 l|Zitrone:1"],
  ["Lachs aus dem Ofen", "Fisch", "Mit Zitrone und Dill", "Lachsfilet:600 g|Zitrone:1|Dill:1 Bund|Olivenöl:2 EL|Knoblauch:2 Zehen"],
  ["Fischknusperli", "Fisch", "Kinderliebling mit Cornflakes-Panade", "Pangasius-Filet:500 g|Cornflakes:100 g|Eier:2|Mehl:50 g|Bratbutter:40 g"],
  ["Forelle Müllerin", "Fisch", "In brauner Butter gebraten", "Forellen:4|Mehl:50 g|Butter:80 g|Zitrone:1|Petersilie:1/2 Bund|Mandelblättchen:30 g"],
  ["Crevetten-Pfanne mit Knoblauch", "Fisch", "Gambas al ajillo", "Crevetten:400 g|Knoblauch:6 Zehen|Chili:1|Olivenöl:1 dl|Petersilie:1/2 Bund|Baguette:1"],
  ["Thunfisch-Steak mit Sesam", "Fisch", "Aussen kross, innen rosa", "Thunfischsteak:4|Sesam:4 EL|Sojasauce:3 EL|Ingwer:15 g|Limette:1|Frühlingszwiebeln:2"],
  ["Bouillabaisse", "Fisch", "Provenzalischer Fischtopf mit Rouille", "Fischfilets gemischt:800 g|Miesmuscheln:500 g|Fenchel:1|Tomaten:4|Safran:1 Briefchen|Fischfond:1 l|Knoblauch:4 Zehen"],
  ["Zander auf Linsenbett", "Fisch", "Mit Beluga-Linsen und Balsamico", "Zanderfilet:600 g|Beluga-Linsen:200 g|Schalotten:2|Balsamico:3 EL|Butter:30 g|Thymian:2 Zweige"],

  // Pasta & Italienisch
  ["Spaghetti Carbonara", "Pasta & Italienisch", "Original mit Guanciale und Pecorino", "Spaghetti:400 g|Guanciale:150 g|Eigelb:4|Pecorino:80 g|Schwarzer Pfeffer:1 TL"],
  ["Lasagne al forno", "Pasta & Italienisch", "Mit Bolognese und Béchamel", "Lasagneblätter:250 g|Hackfleisch:500 g|Tomaten passiert:700 g|Milch:5 dl|Butter:50 g|Mehl:50 g|Parmesan:80 g"],
  ["Risotto ai funghi", "Pasta & Italienisch", "Mit Steinpilzen und Parmesan", "Risottoreis:300 g|Steinpilze getrocknet:30 g|Champignons:200 g|Weisswein:1 dl|Gemüsebrühe:1 l|Parmesan:60 g|Butter:40 g"],
  ["Penne all'arrabbiata", "Pasta & Italienisch", "Scharfe Tomatensauce", "Penne:400 g|Tomaten gehackt:800 g|Knoblauch:3 Zehen|Peperoncino:2|Olivenöl:4 EL|Petersilie:1/2 Bund"],
  ["Pizza Margherita", "Pasta & Italienisch", "Dünner Boden, Tomate, Mozzarella", "Mehl:500 g|Hefe:7 g|Tomaten passiert:300 g|Mozzarella:250 g|Basilikum:1 Bund|Olivenöl:3 EL"],
  ["Gnocchi mit Salbeibutter", "Pasta & Italienisch", "Hausgemacht aus Kartoffeln", "Kartoffeln mehlig:1 kg|Mehl:250 g|Eigelb:1|Butter:80 g|Salbei:1 Bund|Parmesan:50 g"],
  ["Pesto alla genovese", "Pasta & Italienisch", "Mit Trofie, Kartoffeln und Bohnen", "Trofie:400 g|Basilikum:2 Bund|Pinienkerne:40 g|Parmesan:60 g|Knoblauch:1 Zehe|Olivenöl:1 dl|Grüne Bohnen:150 g"],
  ["Ossobuco", "Pasta & Italienisch", "Geschmorte Kalbshaxe mit Gremolata", "Kalbshaxe:4 Tranchen|Karotten:2|Stangensellerie:2|Tomaten gehackt:400 g|Weisswein:2 dl|Zitrone:1|Petersilie:1 Bund"],
  ["Spaghetti aglio, olio e peperoncino", "Pasta & Italienisch", "Mitternachtsspaghetti in 15 Minuten", "Spaghetti:400 g|Knoblauch:4 Zehen|Peperoncino:2|Olivenöl:1 dl|Petersilie:1/2 Bund"],

  // Asiatisch
  ["Pad Thai", "Asiatisch", "Gebratene Reisnudeln mit Erdnüssen", "Reisnudeln:250 g|Crevetten:200 g|Eier:2|Tofu fest:150 g|Sojasprossen:150 g|Erdnüsse:50 g|Tamarindenpaste:2 EL|Fischsauce:3 EL"],
  ["Rotes Thai-Curry", "Asiatisch", "Mit Gemüse und Kokosmilch", "Rote Currypaste:3 EL|Kokosmilch:400 ml|Pouletbrust:400 g|Peperoni rot:1|Bambussprossen:150 g|Thai-Basilikum:1 Bund|Jasminreis:300 g"],
  ["Ramen mit Schweinebauch", "Asiatisch", "Kräftige Brühe, weiches Ei", "Ramen-Nudeln:300 g|Schweinebauch:500 g|Hühnerbrühe:1.5 l|Sojasauce:6 EL|Eier:4|Frühlingszwiebeln:4|Nori:2 Blätter"],
  ["Gebratener Reis", "Asiatisch", "Resteverwertung im Wok", "Reis gekocht:600 g|Eier:3|Erbsen:150 g|Karotten:2|Frühlingszwiebeln:3|Sojasauce:3 EL|Sesamöl:1 EL"],
  ["Sushi-Bowl mit Lachs", "Asiatisch", "Poke-Style mit Avocado und Edamame", "Sushireis:300 g|Lachs (Sashimi-Qualität):300 g|Avocado:1|Edamame:150 g|Gurke:1|Sojasauce:4 EL|Sesam:2 EL"],
  ["Indisches Butter Chicken", "Asiatisch", "Mild-cremig mit Garam Masala", "Pouletbrust:600 g|Joghurt nature:180 g|Butter:50 g|Tomaten passiert:400 g|Rahm:1.5 dl|Garam Masala:2 TL|Ingwer:20 g|Basmatireis:300 g"],
  ["Gyoza", "Asiatisch", "Japanische Teigtaschen, gebraten und gedämpft", "Gyoza-Teigblätter:30|Schweinehackfleisch:300 g|Chinakohl:200 g|Ingwer:15 g|Knoblauch:2 Zehen|Sojasauce:3 EL|Sesamöl:1 EL"],
  ["Bibimbap", "Asiatisch", "Koreanische Reisschüssel mit Gochujang", "Reis:300 g|Rindfleisch:250 g|Spinat:200 g|Karotten:2|Sojasprossen:150 g|Eier:4|Gochujang:3 EL"],

  // Vegetarisch & Vegan
  ["Gemüsecurry mit Kichererbsen", "Vegetarisch & Vegan", "Vegan, schnell und günstig", "Kichererbsen:2 Dosen|Kokosmilch:400 ml|Blumenkohl:1/2|Spinat:150 g|Currypaste:2 EL|Zwiebel:1"],
  ["Falafel mit Hummus", "Vegetarisch & Vegan", "Knusprige Kichererbsenbällchen", "Kichererbsen getrocknet:250 g|Zwiebel:1|Knoblauch:3 Zehen|Petersilie:1 Bund|Koriander:1 Bund|Kreuzkümmel:2 TL|Tahini:3 EL"],
  ["Gefüllte Peperoni", "Vegetarisch & Vegan", "Mit Reis, Feta und Kräutern", "Peperoni:4|Reis:150 g|Feta:150 g|Tomaten gehackt:400 g|Zwiebel:1|Oregano:1 TL"],
  ["Shakshuka", "Vegetarisch & Vegan", "Eier in würziger Tomatensauce", "Eier:6|Tomaten gehackt:800 g|Peperoni rot:2|Zwiebel:1|Knoblauch:2 Zehen|Kreuzkümmel:1 TL|Feta:100 g"],
  ["Linsen-Bolognese", "Vegetarisch & Vegan", "Vegane Alternative zur Klassik", "Rote Linsen:200 g|Tomaten passiert:700 g|Karotten:2|Stangensellerie:2|Zwiebel:1|Spaghetti:400 g"],
  ["Ofengemüse mit Tahini-Dip", "Vegetarisch & Vegan", "Bunt geröstet, vegan", "Süsskartoffeln:2|Randen:2|Rote Zwiebeln:2|Kichererbsen:1 Dose|Tahini:4 EL|Zitrone:1|Olivenöl:4 EL"],
  ["Spinat-Quiche", "Vegetarisch & Vegan", "Mit Ziegenkäse und Pinienkernen", "Kuchenteig:1 Rolle|Spinat:400 g|Ziegenkäse:150 g|Eier:3|Rahm:2 dl|Pinienkerne:30 g"],
  ["Älplermagronen", "Vegetarisch & Vegan", "Mit Apfelmus und Röstzwiebeln", "Hörnli:300 g|Kartoffeln:300 g|Rahm:2 dl|Bergkäse:150 g|Zwiebeln:2|Apfelmus:300 g"],
  ["Tofu-Gemüse-Pfanne", "Vegetarisch & Vegan", "Mit Erdnusssauce", "Tofu fest:400 g|Broccoli:1|Peperoni:1|Erdnussbutter:3 EL|Sojasauce:3 EL|Limette:1|Reis:300 g"],

  // Beilage
  ["Rösti", "Beilage", "Aus gekochten Kartoffeln vom Vortag", "Kartoffeln festkochend:1 kg|Bratbutter:40 g"],
  ["Kartoffelstock", "Beilage", "Cremig mit Muskat", "Kartoffeln mehlig:1 kg|Milch:2 dl|Butter:50 g|Muskatnuss:1 Prise"],
  ["Spätzli", "Beilage", "Von Hand vom Brett geschabt", "Mehl:400 g|Eier:4|Milch:1.5 dl|Wasser:1 dl"],
  ["Ratatouille", "Beilage", "Provenzalisches Schmorgemüse", "Aubergine:1|Zucchetti:2|Peperoni:2|Tomaten:4|Zwiebel:1|Knoblauch:3 Zehen|Thymian:3 Zweige"],
  ["Rotkraut", "Beilage", "Mit Apfel und Zimt geschmort", "Rotkohl:1 kg|Äpfel:2|Zwiebel:1|Rotwein:1 dl|Rotweinessig:3 EL|Zimtstange:1|Nelken:3"],
  ["Ofenkartoffeln mit Rosmarin", "Beilage", "", "Kartoffeln:1 kg|Rosmarin:3 Zweige|Olivenöl:4 EL|Fleur de Sel:1 TL"],
  ["Polenta", "Beilage", "Cremig mit Parmesan", "Maisgriess:250 g|Gemüsebrühe:1 l|Butter:40 g|Parmesan:50 g"],

  // Brot & Backwaren
  ["Butterzopf", "Brot & Backwaren", "Sonntagszopf wie vom Beck", "Zopfmehl:1 kg|Butter:120 g|Milch:6 dl|Hefe:20 g|Zucker:1 TL|Ei:1"],
  ["Ruchbrot", "Brot & Backwaren", "Mit langer Teigführung", "Ruchmehl:500 g|Wasser:3.5 dl|Hefe:5 g"],
  ["Focaccia", "Brot & Backwaren", "Mit Rosmarin und grobem Salz", "Mehl:500 g|Wasser:4 dl|Hefe:7 g|Olivenöl:8 EL|Rosmarin:2 Zweige|Fleur de Sel:1 TL"],
  ["Laugenbrötchen", "Brot & Backwaren", "Mit Natronlauge – Handschuhe tragen!", "Mehl:500 g|Wasser:2.8 dl|Butter:30 g|Hefe:10 g|Natron:3 EL|Hagelsalz:2 EL"],
  ["Dinkel-Vollkornbrot", "Brot & Backwaren", "Mit Kernen, ohne Kneten", "Dinkelvollkornmehl:500 g|Sonnenblumenkerne:80 g|Leinsamen:40 g|Wasser:5 dl|Hefe:10 g|Apfelessig:1 EL"],
  ["Zwiebelkuchen", "Brot & Backwaren", "Herbstklassiker mit Speck und Kümmel", "Hefeteig:1|Zwiebeln:1 kg|Speckwürfel:150 g|Schmand:400 g|Eier:3|Kümmel:1 TL"],
  ["Gipfeli", "Brot & Backwaren", "Blätterteig-Gipfeli, aufwendig aber lohnend", "Mehl:500 g|Butter:250 g|Milch:2.5 dl|Hefe:20 g|Zucker:50 g|Ei:1"],
  ["Sauerteigbrot", "Brot & Backwaren", "Mit aktivem Anstellgut", "Weissmehl:450 g|Roggenmehl:50 g|Anstellgut:100 g|Wasser:3.5 dl"],

  // Dessert & Kuchen
  ["Apfelwähe", "Dessert & Kuchen", "Mit Rahmguss", "Kuchenteig:1 Rolle|Äpfel:4|Rahm:2 dl|Eier:2|Zucker:60 g|Zimt:1 TL"],
  ["Rüeblitorte", "Dessert & Kuchen", "Aargauer Art mit Marzipan-Rüebli", "Karotten:300 g|Gemahlene Mandeln:300 g|Zucker:250 g|Eier:5|Mehl:80 g|Puderzucker:150 g"],
  ["Schokoladenmousse", "Dessert & Kuchen", "Luftig, dunkel, ohne Gelatine", "Dunkle Schokolade:200 g|Eier:4|Rahm:2 dl|Zucker:40 g"],
  ["Tiramisu", "Dessert & Kuchen", "Mit Mascarpone und Espresso", "Löffelbiskuits:200 g|Mascarpone:500 g|Eier:4|Zucker:80 g|Espresso:3 dl|Kakaopulver:2 EL"],
  ["Crème brûlée", "Dessert & Kuchen", "Mit knuspriger Zuckerkruste", "Rahm:5 dl|Eigelb:6|Zucker:100 g|Vanilleschote:1"],
  ["Cheesecake New York Style", "Dessert & Kuchen", "Mit Graham-Boden", "Frischkäse:900 g|Zucker:200 g|Eier:4|Sauerrahm:200 g|Butterkekse:200 g|Butter:80 g"],
  ["Meringues mit Doppelrahm", "Dessert & Kuchen", "Greyerzer Klassiker", "Eiweiss:4|Zucker:240 g|Doppelrahm:250 g|Erdbeeren:250 g"],
  ["Vermicelles", "Dessert & Kuchen", "Marronipüree mit Schlagrahm", "Marronipüree:500 g|Rahm:2.5 dl|Kirsch:2 EL|Meringues:4"],
  ["Brownies", "Dessert & Kuchen", "Saftig mit Baumnüssen", "Dunkle Schokolade:200 g|Butter:180 g|Zucker:250 g|Eier:4|Mehl:100 g|Baumnüsse:100 g"],

  // Fruehstueck
  ["Bircher Müesli", "Frühstück", "Original nach Dr. Bircher-Benner", "Haferflocken:150 g|Milch:3 dl|Joghurt nature:180 g|Äpfel:2|Zitrone:1/2|Haselnüsse:40 g|Beeren:150 g"],
  ["Pancakes", "Frühstück", "Fluffig, mit Ahornsirup", "Mehl:200 g|Milch:2.5 dl|Eier:2|Backpulver:2 TL|Zucker:2 EL|Butter:30 g|Ahornsirup:1 dl"],
  ["Eggs Benedict", "Frühstück", "Mit Sauce hollandaise", "English Muffins:2|Eier:4|Schinken:4 Tranchen|Eigelb:3|Butter:150 g|Zitrone:1/2"],
  ["Overnight Oats", "Frühstück", "Am Vorabend vorbereitet", "Haferflocken:100 g|Mandelmilch:2.5 dl|Chiasamen:2 EL|Ahornsirup:1 EL|Beeren:150 g"],
  ["Rührei mit Kräutern", "Frühstück", "Cremig, langsam gestockt", "Eier:6|Butter:20 g|Rahm:3 EL|Schnittlauch:1/2 Bund"],
  ["Avocado-Toast", "Frühstück", "Mit pochiertem Ei und Chili", "Sauerteigbrot:4 Scheiben|Avocado:2|Eier:4|Limette:1|Chiliflocken:1 Prise"],
  ["French Toast", "Frühstück", "Fotzelschnitten mit Zimtzucker", "Zopf:8 Scheiben|Eier:3|Milch:2 dl|Zucker:2 EL|Zimt:1 TL|Butter:30 g"],

  // Getraenk
  ["Glühwein", "Getränk", "Mit Orange und Gewürzen", "Rotwein:1 l|Orange:1|Zimtstange:2|Nelken:5|Sternanis:2|Zucker:80 g"],
  ["Hausgemachter Eistee", "Getränk", "Mit Pfirsich und Minze", "Schwarztee:4 Beutel|Wasser:1.5 l|Pfirsiche:2|Zitrone:1|Minze:1 Bund|Zucker:60 g"],
  ["Holunderblütensirup", "Getränk", "Im Juni ansetzen", "Holunderblüten:25 Dolden|Wasser:2 l|Zucker:2 kg|Zitronen:3|Zitronensäure:40 g"],
  ["Heisse Schokolade", "Getränk", "Mit echter Schokolade", "Milch:5 dl|Dunkle Schokolade:100 g|Rahm:1 dl|Zimt:1 Prise"],
  ["Smoothie Grün", "Getränk", "Spinat, Banane, Apfel", "Spinat:80 g|Banane:1|Apfel:1|Ingwer:10 g|Wasser:2 dl"],
  ["Mango-Lassi", "Getränk", "Indischer Joghurtdrink", "Mango:1|Joghurt nature:360 g|Milch:1 dl|Kardamom:1 Prise|Honig:1 EL"],

  // Randfaelle: ohne Kategorie, Sonderzeichen, maximale Laengen
  ["Omas Resteessen", "", "Ohne Kategorie – was der Kühlschrank hergibt", "Kartoffeln:4|Eier:3|Zwiebel:1|Käse:80 g|Schinken:100 g"],
  ["Salz & Pfeffer <Test> \"Sonderzeichen\"", "", "Prüft die Darstellung von & < > \" ' in Tabelle und Dialog", "Salz:1 Prise|Pfeffer:1 Prise|Wasser:1 l"],
  ["Ein Rezept mit einem ausgesprochen langen Namen, der die Spaltenbreite testet ok", "Beilage",
    "Diese Kurzbeschreibung reizt die erlaubten 150 Zeichen voll aus, damit man sieht, wie die Übersicht abschneidet und ob der Tooltip korrekt ist.",
    "Kartoffeln:1 kg|Butter:50 g"],
  ["Nur Name", "", "", ""],
];

const COOK_VERBS = {
  "Suppe": ["anschwitzen", "mit Flüssigkeit ablöschen", "köcheln lassen", "fein pürieren"],
  "Vorspeise & Salat": ["waschen und rüsten", "in mundgerechte Stücke schneiden", "mit der Sauce mischen", "kurz ziehen lassen"],
  "Fleisch": ["parieren und würzen", "scharf anbraten", "bei niedriger Hitze garen", "vor dem Anschneiden ruhen lassen"],
  "Fisch": ["trocken tupfen und würzen", "auf der Hautseite braten", "glasig garen", "mit Zitrone beträufeln"],
  "Pasta & Italienisch": ["in reichlich Salzwasser al dente kochen", "die Sauce einkochen", "mit etwas Kochwasser binden", "mit Käse vollenden"],
  "Asiatisch": ["alle Zutaten vorbereiten", "im heissen Wok anbraten", "mit Sauce ablöschen", "mit Kräutern garnieren"],
  "Vegetarisch & Vegan": ["Gemüse rüsten", "kräftig anrösten", "würzen und schmoren", "abschmecken"],
  "Beilage": ["vorbereiten", "garen", "würzen", "warm stellen"],
  "Brot & Backwaren": ["zu einem glatten Teig kneten", "zugedeckt gehen lassen", "formen", "im vorgeheizten Ofen backen"],
  "Dessert & Kuchen": ["schaumig rühren", "sorgfältig unterheben", "backen oder kühl stellen", "vor dem Servieren dekorieren"],
  "Frühstück": ["bereitstellen", "verrühren", "kurz garen", "frisch servieren"],
  "Getränk": ["vorbereiten", "aufkochen oder mixen", "ziehen lassen", "eiskalt oder heiss servieren"],
  "": ["vorbereiten", "garen", "abschmecken", "servieren"],
};

const TIPS = [
  "Lässt sich gut am Vortag vorbereiten.",
  "Schmeckt aufgewärmt fast noch besser.",
  "Für Gäste die Menge einfach verdoppeln.",
  "Passt zu einem Glas Weisswein aus der Region.",
  "Reste halten sich zugedeckt zwei Tage im Kühlschrank.",
  "Kinder helfen hier gerne mit.",
  "Saisonal variieren – im Sommer mit frischen Kräutern.",
  "Nicht zu früh salzen.",
];

function parseIngredients(spec) {
  if (!spec) return [];
  return spec.split("|").map((part) => {
    const [name, amount = ""] = part.split(":");
    return { name: name.trim(), amount: amount.trim() };
  });
}

function longTextFor(name, category, ingredients) {
  if (name === "Nur Name") return "";
  const verbs = COOK_VERBS[category] || COOK_VERBS[""];
  const names = ingredients.map((i) => i.name);
  const portions = between(2, 6);
  const minutes = between(2, 18) * 5;
  const lines = [
    `Für ${portions} Personen · Zubereitung ca. ${minutes} Minuten`,
    "",
    `1. ${names.slice(0, 2).join(" und ") || "Alle Zutaten"} ${verbs[0]}.`,
    `2. ${names.slice(2, 4).join(" und ") || "Die übrigen Zutaten"} dazugeben und ${verbs[1]}.`,
    `3. ${verbs[2].charAt(0).toUpperCase() + verbs[2].slice(1)}, dabei gelegentlich prüfen.`,
    `4. Mit Salz und Pfeffer abschmecken und ${verbs[3]}.`,
    "",
    `Tipp: ${pick(TIPS)}`,
  ];
  return lines.join("\n");
}

/* ------------------------------------------------------------- Bilder */

const CATEGORY_COLORS = {
  "Suppe": ["#e07a2f", "#f6c28b"],
  "Vorspeise & Salat": ["#4f9d4a", "#bde3a8"],
  "Fleisch": ["#a33b2f", "#e9a196"],
  "Fisch": ["#2f6fa3", "#9fcbea"],
  "Pasta & Italienisch": ["#c9a227", "#f3e2a0"],
  "Asiatisch": ["#b8342c", "#f2b8a8"],
  "Vegetarisch & Vegan": ["#2e8b57", "#a8e0bf"],
  "Beilage": ["#9c7a3c", "#e6d2a8"],
  "Brot & Backwaren": ["#a0662f", "#ecc996"],
  "Dessert & Kuchen": ["#b04a7a", "#f2bdd6"],
  "Frühstück": ["#d9a21b", "#fbe3a1"],
  "Getränk": ["#6a4fb0", "#cfc2f0"],
  "": ["#6b7280", "#d1d5db"],
};

function xml(str) {
  return String(str).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[c])
  );
}

/** Einfaches SVG-Platzhalterbild: Farbverlauf der Kategorie, Teller, Rezeptname. */
function imageFor(name, category, index, total) {
  const [dark, light] = CATEGORY_COLORS[category] || CATEGORY_COLORS[""];
  const title = name.length > 34 ? name.slice(0, 33) + "…" : name;
  const cx = 400 + (index % 2 ? 140 : -140) * (index > 0 ? 1 : 0);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600" viewBox="0 0 800 600">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
<stop offset="0" stop-color="${light}"/><stop offset="1" stop-color="${dark}"/></linearGradient></defs>
<rect width="800" height="600" fill="url(#g)"/>
<circle cx="${cx}" cy="270" r="170" fill="#ffffff" fill-opacity="0.85"/>
<circle cx="${cx}" cy="270" r="120" fill="${dark}" fill-opacity="0.35"/>
<circle cx="${cx - 40}" cy="240" r="28" fill="${light}"/>
<circle cx="${cx + 35}" cy="290" r="22" fill="${light}"/>
<text x="400" y="520" text-anchor="middle" font-family="Segoe UI, Helvetica, Arial, sans-serif" font-size="40" font-weight="600" fill="#ffffff">${xml(title)}</text>
<text x="400" y="565" text-anchor="middle" font-family="Segoe UI, Helvetica, Arial, sans-serif" font-size="22" fill="#ffffff" fill-opacity="0.85">${xml(category || "ohne Kategorie")} · Bild ${index + 1} von ${total} · Testdaten</text>
</svg>`;
  return {
    name: index === 0 ? "titelbild.svg" : `schritt-${index + 1}.svg`,
    dataUrl: "data:image/svg+xml;base64," + Buffer.from(svg, "utf8").toString("base64"),
  };
}

/* ------------------------------------------------------------ Benutzer */

const FIRST_NAMES = [
  "Anna", "Lukas", "Mia", "Noah", "Laura", "Elias", "Lea", "Luca", "Sara", "Jonas",
  "Nina", "David", "Lena", "Simon", "Julia", "Marco", "Chiara", "Fabian", "Seraina", "Reto",
  "Martina", "Beat", "Ursula", "Matthias", "Céline", "Yannick", "Andrea", "Patrick", "Sabine", "Thomas",
];
const LAST_NAMES = [
  "Meier", "Müller", "Keller", "Brunner", "Huber", "Baumann", "Frei", "Gerber", "Steiner", "Fischer",
  "Weber", "Schmid", "Zimmermann", "Moser", "Graf", "Wyss", "Bühler", "Roth", "Suter", "Hofer",
];

function makeUsernames(count) {
  const names = new Set();
  let i = 0;
  while (names.size < count) {
    const first = FIRST_NAMES[i % FIRST_NAMES.length];
    const last = LAST_NAMES[(i * 7 + Math.floor(i / LAST_NAMES.length)) % LAST_NAMES.length];
    const name = `${first}.${last}`.toLowerCase();
    names.add(names.has(name) ? `${name}${i}` : name);
    i++;
  }
  return [...names];
}

/* -------------------------------------------------------- Ablauf */

function readTestAccountIds(raw) {
  const row = raw.prepare("SELECT value FROM meta WHERE key = ?").get(META_KEY);
  try { return row ? JSON.parse(row.value) : []; } catch { return []; }
}

/** Entfernt Testrezepte (id "test-...") und vermerkte Testbenutzer. */
function removeTestData(raw) {
  const recipes = raw.prepare(`DELETE FROM recipes WHERE id LIKE '${ID_PREFIX}%'`).run().changes;
  const ids = readTestAccountIds(raw).filter((id) => Number(id) !== db.ADMIN_ID);
  let accounts = 0;
  const del = raw.prepare("DELETE FROM accounts WHERE id = ?");
  for (const id of ids) accounts += del.run(Number(id)).changes;
  raw.prepare("DELETE FROM meta WHERE key = ?").run(META_KEY);
  return { recipes, accounts };
}

function main() {
  // 1. Schema anlegen bzw. aktualisieren (legt bei Bedarf den Admin an).
  const { generatedAdminPassword } = db.open(DB_FILE, { adminPassword: process.env.KOCHBUCH_ADMIN_PASSWORD });
  db.close();

  const raw = new DatabaseSync(DB_FILE);
  raw.exec("PRAGMA foreign_keys = ON");
  raw.exec("PRAGMA busy_timeout = 5000");

  // 2. Alte Testdaten weg - so ist der Lauf beliebig wiederholbar.
  const removed = removeTestData(raw);
  if (removed.recipes || removed.accounts) {
    console.log(`Entfernt:  ${removed.recipes} Testrezepte, ${removed.accounts} Testbenutzer`);
  }
  if (REMOVE_ONLY) {
    if (!removed.recipes && !removed.accounts) console.log("Keine Testdaten vorhanden.");
    raw.close();
    return;
  }
  raw.close();

  // 3. Neu anlegen ueber db.js - mit denselben Pruefungen wie die API.
  db.open(DB_FILE);
  const usernames = makeUsernames(USER_COUNT);
  const accounts = [];
  for (let i = 0; i < usernames.length; i++) {
    // Etwa zwei Drittel mit Schreibrecht, der Rest nur lesend.
    const role = i % 3 === 2 ? "r" : "rw";
    try {
      accounts.push(db.createAccount({ username: usernames[i], password: TEST_PASSWORD, role }));
    } catch (err) {
      console.warn(`Benutzer "${usernames[i]}" übersprungen: ${err.message}`);
    }
  }
  const writers = [{ id: db.ADMIN_ID }, ...accounts.filter((a) => a.role === "rw")];

  const created = [];
  for (let i = 0; i < RECIPE_COUNT; i++) {
    const base = RECIPES[i % RECIPES.length];
    const round = Math.floor(i / RECIPES.length);
    const name = round === 0 ? base[0] : `${base[0]} (Variante ${round + 1})`.slice(0, 80);
    const category = base[1];
    const ingredients = parseIngredients(base[3]);
    // Bilder: etwa jedes fuenfte Rezept ohne Bild, sonst 1-3.
    const imageCount = name === "Nur Name" || rand() < 0.2 ? 0 : between(1, 3);
    const images = Array.from({ length: imageCount }, (_, k) => imageFor(name, category, k, imageCount));

    // Ersteller gewichtet: der Admin hat am meisten Rezepte.
    const owner = rand() < 0.3 ? writers[0] : pick(writers);
    const recipe = db.createRecipe({
      id: `${ID_PREFIX}${String(i + 1).padStart(3, "0")}`,
      name,
      shortDesc: base[2],
      longText: longTextFor(name, category, ingredients),
      category,
      ingredients,
      images,
    }, owner.id);
    created.push(recipe.id);
  }
  db.close();

  // 4. Zeitstempel ueber das letzte Jahr verteilen (sonst sind alle "jetzt"),
  //    damit die Sortierung nach "Geaendert" etwas zu sortieren hat.
  const now = Date.now();
  const day = 86400000;
  const touch = new DatabaseSync(DB_FILE);
  touch.exec("PRAGMA busy_timeout = 5000");
  const setRecipe = touch.prepare("UPDATE recipes SET created_at = ?, updated_at = ? WHERE id = ?");
  const setAccount = touch.prepare("UPDATE accounts SET created_at = ? WHERE id = ?");
  touch.exec("BEGIN");
  for (const id of created) {
    const createdAt = now - between(30, 365) * day - between(0, 86399) * 1000;
    const updatedAt = Math.min(now, createdAt + between(0, 60) * day + between(0, 86399) * 1000);
    setRecipe.run(new Date(createdAt).toISOString(), new Date(updatedAt).toISOString(), id);
  }
  for (const a of accounts) {
    setAccount.run(new Date(now - between(60, 400) * day).toISOString(), a.id);
  }
  touch.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)")
    .run(META_KEY, JSON.stringify(accounts.map((a) => a.id)));
  touch.exec("COMMIT");
  touch.close();

  // 5. Zusammenfassung
  db.open(DB_FILE);
  const stats = db.getStats();
  const perUser = db.listAccounts();
  db.close();

  console.log(`Datenbank: ${DB_FILE}`);
  console.log(`Angelegt:  ${created.length} Rezepte, ${accounts.length} Benutzer`);
  console.log(`Bestand:   ${stats.recipes} Rezepte, ${stats.ingredients} Zutaten, ${stats.images} Bilder, ${stats.accounts} Benutzer`);
  console.log(`Testbenutzer-Passwort: ${TEST_PASSWORD}  (z.B. ${accounts[0] ? accounts[0].username : "-"})`);
  console.log("Rezepte je Benutzer:");
  for (const u of perUser) console.log(`  ${u.username.padEnd(22)} ${u.role.padEnd(5)} ${u.recipeCount}`);
  if (generatedAdminPassword && !process.env.KOCHBUCH_ADMIN_PASSWORD) {
    console.log(`Hinweis:   Datenbank war neu - Admin "${db.ADMIN_USERNAME}", Startpasswort: ${generatedAdminPassword}`);
  }
  console.log("Entfernen mit: node testdaten.js --entfernen");
}

main();
