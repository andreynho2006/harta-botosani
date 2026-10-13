# Harta Botoșani

Hartă interactivă a județului Botoșani pentru pregătire și intervenții: drumuri pe categorii (DN, DJ, DC, străzi, drumuri de exploatare), ape, baraje, localități, UAT-uri, clădiri, instituții (ISU, poliție, jandarmerie, poliție de frontieră, SAJ, spitale, primării, școli) și hidranți.

Proiect personal. Rulează în browser, pe PC sau laptop.

## Ce face

- **Căutare** după localitate, stradă, adresă, instituție, număr de hidrant sau coordonate (WGS84 zecimal, grade-minute-secunde, Stereo 70).
- **Fișă la clic** pe orice obiect: categorie, număr drum, pod, tonaj și gabarit (unde există), nivele clădire, adresă, coordonate WGS84 / GMS / Stereo 70.
- **Analiza unui punct** (clic dreapta): cei mai apropiați hidranți, subunitatea ISU, spitalul, ambulanța și poliția, cu distanță și direcție; clădirile și obiectivele dintr-o rază (50 m – 2 km); rezumat de copiat.
- **Măsurare** de distanțe, fundal **hartă / satelit**, mod **zi / noapte**, export imagine.

Distanțele sunt în linie dreaptă, nu pe drum.

## Cum se actualizează

| Ce | Unde | Cum |
|---|---|---|
| Date OpenStreetMap | automat | lunar, pe 1 ale lunii (workflow „Date hartă”) |
| Lista hidranților | `data/hidranti/` | pune fișierul (CSV, Excel, GeoJSON sau KML); harta se reconstruiește singură |
| Aplicația | `web/` | orice modificare se publică automat (workflow „Site”) |

Ramura `site` conține aplicația gata de publicat. Ramura `date` conține doar tile-urile și datele.

## Structură

```
pipeline/   descărcare OSM, decupare județ, straturi, index de căutare, hidranți
web/        aplicația (MapLibre GL, fără server, fără conturi externe)
data/       lista hidranților (fișierul primit de la ISU)
```

## Surse

- © contribuitorii [OpenStreetMap](https://www.openstreetmap.org/copyright), licență ODbL
- Imagini satelitare: Esri World Imagery
- Fonturi: Noto Sans (licență OFL), bibliotecă hartă: MapLibre GL JS (BSD-3)

Datele OpenStreetMap pot fi incomplete. Informațiile critice se verifică din surse oficiale.
