# Harta Botoșani

Hartă interactivă a județului Botoșani pentru pregătire și intervenții: drumuri pe categorii (DN, DJ, DC, străzi, drumuri de exploatare), ape, baraje, localități, UAT-uri, clădiri, instituții (ISU, poliție, jandarmerie, poliție de frontieră, SAJ, spitale, primării, școli) și hidranți.

Proiect personal. Rulează în browser, pe PC sau laptop.

## Ce face

- **Căutare** după localitate, stradă, adresă, instituție, număr de hidrant sau coordonate (WGS84 zecimal, grade-minute-secunde, Stereo 70).
- **Fișă la clic** pe orice obiect: categorie, număr drum, pod, tonaj și gabarit (unde există), nivele clădire, adresă, coordonate WGS84 / GMS / Stereo 70.
- **Analiza unui punct** (clic dreapta): cei mai apropiați hidranți, subunitatea ISU, spitalul, ambulanța și poliția, cu distanță și direcție; clădirile și obiectivele dintr-o rază (50 m – 2 km); rezumat de copiat.
- **Măsurare** de distanțe, fundal **hartă / satelit**, mod **zi / noapte**, export imagine.
- **Focalizare UAT și localități pe harta principală:** alege un punct sau o localitate și apasă „Focalizează UAT” sau „Focalizează satul” din fișa de informații ori din meniul contextual (clic dreapta). Harta principală se încadrează pe UAT-urile și satele selectate, cu opțiunea de izolare a conturului direct din bara de sus (fără fereastră modală separată).
- **Profiluri de straturi CJSU (1-click):** implicit sunt bifate doar straturile esențiale pentru ședință (UAT, localități, DN/DJ/DC, ape, subunități ISU), cu butoane rapide pentru *Hartă CJSU (Bază)*, *❄️ Înzăpezire*, *🌊 Inundații*, *🔥 Incendiu*, *⛈️ Furtună* și *Toate*.

Distanțele din analiza unui punct sunt în linie dreaptă, nu pe drum.

## Cum se actualizează

| Ce | Unde | Cum |
|---|---|---|
| OpenStreetMap data | manual only | Automatic updates are paused; run the “Date hartă” workflow only when a refresh is wanted. |
| Lista hidranților | aplicație → Administrare | încarci fișierul (Excel, CSV, GeoJSON, KML), descarci `hidranti.enc` și îl urci în `web/data/` |
| Baza de date situații CJSU | aplicație → Situații | creezi/editezi situația, apeși **Salvează în JSON (`situatii.json`)** și actualizezi `web/data/situatii.json` |
| Utilizatori | aplicație → Administrare | adaugi sau resetezi, descarci `users.json` și îl urci în `web/` |
| Aplicația | `web/` | orice modificare se publică automat (workflow „Site”) |

Ramura `site` conține aplicația gata de publicat. Ramura `date` conține doar tile-urile și datele.

OSM hydrants are currently hidden from the map, layer controls, and search. The ISU hydrant list remains available.

Road restrictions retain their original OSM values and units on future manual data builds. Existing tiles discarded units, so the app marks those values as unverified rather than assuming tonnes or meters.

## Acces și securitate

Aplicația cere utilizator și parolă. Hidranții sunt publicați doar criptați (AES-GCM); cheia lor
se deschide numai cu parola unui utilizator (PBKDF2-SHA256, 310.000 iterații). În repository nu
există parole și nici lista de hidranți necriptată. Datele OpenStreetMap sunt publice oricum.

After publishing a password reset in `web/users.json`, saved sessions require a fresh login on the next page load. Existing sessions from before this fix also require one fresh login. A reset changes password access; it does not rotate the shared data encryption key or erase data already downloaded.

## Validation

Run `node --test tests/*.test.mjs` and `python3 -m unittest discover -s tests -p 'test_*.py'`. These checks do not download or rebuild map data.

## Situații operative CJSU

În fila **Situații** gestionezi evenimentele operative pentru ședințele Comitetului Județean pentru Situații de Urgență (CJSU):

1. **Marcare drumuri blocate / impracticabile cu negru (`#080808` cu halou alb și borne la capete):**
   - **Automat după km:** introduci drumul (ex. `DJ29`, `DN29`, `DJ291`, `DJ282`, `DC10`) și kilometrii (ex. de la `km 3` la `km 6`) și apeși **Trasează automat pe hartă**. Drumul este decupat automat pe geometria reală din `web/data/roads.json` (230 de drumuri DN, DJ și DC din județ).
   - **Automat între 2 localități:** alegi două localități de pe traseul drumului și sectorul dintre ele este trasat automat.
   - **Cu 2 clicuri pe hartă:** alegi două puncte pe drum la orice nivel de zoom; traseul urmărește geometria drumului și calculează automat km de început, km de sfârșit și lungimea sectorului.
2. **Zone afectate și forțe în teren:**
   - Zone inundate, posibil inundabile / amenințate (contur punctat), incendiu de amploare, perimetru de evacuare.
   - Sate / localități izolate, localități fără curent electric, Punct de Comandă Mobil (PCM), echipaje ISU, filtre IPJ / IJJ, echipaje SAJ / SMURD, utilaje SDN / DJDP / SGA și puncte de adăpostire / evacuare.
   - Colorare opțională a UAT-urilor selectate în culoarea codului ANM / RO-Alert (galben, portocaliu, roșu).
3. **Bază de date JSON (`web/data/situatii.json`) și Arhivă:**
   - La pornire, aplicația încarcă automat evenimentele din `web/data/situatii.json` și le sincronizează cu `localStorage`.
   - Orice modificare este salvată instant local; butonul **Salvează în JSON (`situatii.json`)** descarcă fișierul JSON actualizat cu toate evenimentele pentru arhivare sau publicare în repository.
4. **Mod Prezentare CJSU (`Prezintă în ședință`):**
   - Afișează harta pe tot ecranul cu antetul ședinței, codul ANM / RO-Alert, legenda operativă și un **panou de sinteză CJSU interactiv** (clic pe orice drum blocat, zonă, forță sau UAT centrează harta pe acel element), plus comenzi rapide pentru *Hartă / Satelit*, *Zi / Noapte*, *Izolează zona* și *Încadrează*.

## Itinerare de intervenție

În **Situații → Adaugă pe hartă → Itinerar de bază și de rezervă**, alegi subunitatea și obiectivul din listă sau marchezi intrarea în obiectiv pe hartă. Cele opt puncte de plecare sunt grupate pe detașamente și stație; o plecare poate fi folosită numai după completarea coordonatelor în lista oficială din Administrare. Punctele OSM neconfirmate nu sunt folosite automat.

Calculul folosește toate cele șapte categorii de drumuri, independent de straturile vizibile și poziția hărții. Favorizează arterele principale față de scurtături prin alei de acces sau drumuri de exploatare, păstrând aceste drumuri când sunt necesare. Alegerea rezervei ține cont și de independența față de traseul de bază; distanțele afișate rămân lungimile reale, nu costurile de selecție. Rețeaua din `web/data/routing-roads.json` conține 15.916 drumuri reconstruite din snapshotul existent din 13.10.2026; harta de bază nu a fost actualizată. Datele se încarcă la primul calcul, într-un Web Worker. Traseul de bază este turcoaz, iar rezerva este portocalie și întreruptă. O rezervă este oferită numai când există un traseu suficient de diferit; sectoarele marcate blocate și nerezolvate sunt excluse. Ambele trasee se păstrează în situație și în exportul JSON.

Traseele sunt propuneri de planificare: snapshotul nu conține toate sensurile, restricțiile de viraj sau de acces/gabarit, iar conexiunile până la drum nu sunt inventate. Verifică accesul efectiv pentru autospecială.

Reconstrucția offline, fără descărcări OSM: instalează `mapbox-vector-tile==2.2.0`, apoi rulează `python pipeline/build-routing-snapshot.py <director-tiles> web/data/routing-roads.json --zoom 15`. Testele suplimentare ale constructorului sunt în `tests/test_routing_snapshot.py`.

## Structură

```
pipeline/   descărcare OSM, decupare județ, straturi, index de căutare, hidranți
web/        aplicația (MapLibre GL, fără server, fără conturi externe)
```

## Surse

- © contribuitorii [OpenStreetMap](https://www.openstreetmap.org/copyright), licență ODbL
- Imagini satelitare: Esri World Imagery
- Fonturi: Noto Sans (licență OFL), bibliotecă hartă: MapLibre GL JS (BSD-3)

Datele OpenStreetMap pot fi incomplete. Informațiile critice se verifică din surse oficiale.
