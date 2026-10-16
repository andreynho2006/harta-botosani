# Harta Botoșani

Hartă interactivă a județului Botoșani pentru pregătire și intervenții: drumuri pe categorii (DN, DJ, DC, străzi, drumuri de exploatare), ape, baraje, localități, UAT-uri, clădiri, instituții (ISU, poliție, jandarmerie, poliție de frontieră, SAJ, spitale, primării, școli) și hidranți.

Proiect personal. Rulează în browser, pe PC sau laptop.

## Ce face

- **Căutare** după localitate, stradă, adresă, instituție, număr de hidrant sau coordonate (WGS84 zecimal, grade-minute-secunde, Stereo 70).
- **Fișă la clic** pe orice obiect: categorie, număr drum, pod, tonaj și gabarit (unde există), nivele clădire, adresă, coordonate WGS84 / GMS / Stereo 70.
- **Analiza unui punct** (clic dreapta): cei mai apropiați hidranți, subunitatea ISU, spitalul, ambulanța și poliția, cu distanță și direcție; clădirile și obiectivele dintr-o rază (50 m – 2 km); rezumat de copiat.
- **Măsurare** de distanțe, fundal **hartă / satelit**, mod **zi / noapte**, export imagine.
- **Commune map:** select a point, then choose “Harta comunei” in its details or context menu. A separate map shows the selected administrative territory, with short faded road exits and no neighboring settlement labels. The modal supports zoom, recentering, Escape, and mobile screens; it uses existing data without a map rebuild.

Distanțele sunt în linie dreaptă, nu pe drum.

## Cum se actualizează

| Ce | Unde | Cum |
|---|---|---|
| OpenStreetMap data | manual only | Automatic updates are paused; run the “Date hartă” workflow only when a refresh is wanted. |
| Lista hidranților | aplicație → Administrare | încarci fișierul (Excel, CSV, GeoJSON, KML), descarci `hidranti.enc` și îl urci în `web/data/` |
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

## Operational situations (first version)

Open the **Situații** tab to create an event. Select one or more communes/cities on the main map, or keep the county context. Add affected areas, operational points, or a road section by choosing two endpoints on the same visible road. Road sections follow the connected geometry in the loaded tiles; when a route cannot be established, select a shorter section or zoom in. Kilometer values are descriptive labels supplied by the operator, not automatic geolocation by official chainage.

Blocked road sections are black with a white outline. Every annotation has a reported/potential/confirmed/resolved status, an observation time, source, and notes. Warning text, source, validity, and code are entered manually; this version does not fetch warnings or calculate flood forecasts. Operational times use Europe/Bucharest.

**Salvează situația** stores the event in this browser's local archive. **Exportă situația JSON** exports the current event, including unsaved event changes once all markers are finalized. **Exportă arhiva JSON** includes saved events only. **Importă JSON** validates the complete file before merging, keeps the newer version of matching event IDs, and leaves the existing archive intact on errors. Keep exported files for backup and transfer; this is not a shared server database. The archive contains manually entered operational information, geometries, map view, and layer choices; it does not include login credentials or the ISU hydrant dataset.

**Prezintă** shows the event on the main map with its title, warning, legend, and update time. Escape or **Ieși din prezentare** returns to editing. The previous commune modal remains available independently.

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
