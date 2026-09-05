# Bedeem

Én lettlest, tekstbasert strøm med innhold fra flere kilder, laget for mobil og
for sporadisk nettilgang. Publiseres med GitHub Pages på <https://bedeem.com>.

## Slik virker det

- **`scripts/fetch.mjs`** kjøres av GitHub Actions hvert 10. minutt
  (`.github/workflows/fetch.yml`). Fordi GitHubs cron-tidsplan ofte er kraftig
  forsinket, starter hver kjøring den neste selv når den er ferdig; tidsplanen er
  reserve. Skulle kjeden stoppe (f.eks. etter et GitHub-avbrudd), starter den igjen
  ved neste cron-kjøring, ved push av skript/kildeliste, eller ved å trykke
  «Run workflow» under Actions. Skriptet henter fra kildene i `sources.json`,
  normaliserer alt til samme format (tid, tittel, brødtekst, ev. svar i tråd) og
  skriver dagsfiler til `data/days/ÅÅÅÅ-MM-DD.json` samt `data/index.json`.
  Ingen avhengigheter – bare Node 20+.
- **Nettsiden** (`index.html`, `app.js`, `styles.css`) laster `data/index.json`
  og så mange dagsfiler som trengs for å fylle bufferen (50, 100 eller 1000
  innlegg, standard 1000). Alt vises i én uendelig strøm.
- **`sw.js`** (service worker) bufrer appen og alle nedlastede datafiler, slik at
  siden fortsetter å virke når nettet forsvinner.
- Innstillinger (tekststørrelse, bufferstørrelse, skjulte kilder) lagres per
  enhet i `localStorage`. Ingen pålogging.

## Legge til en kilde

Legg til et objekt i `sources` i `sources.json`. Støttede typer:

| type       | felter                                                  | eksempel                 |
|------------|---------------------------------------------------------|--------------------------|
| `rss`      | `url` (RSS 2.0 eller Atom)                               | VG, Nettavisen           |
| `reddit`   | `subreddit`, `listing` (`new`, `hot`, `top`)             | r/norge                  |
| `invision` | `url` til aktivitetsstrømmen i et Invision-forum         | Kvinneguiden             |
| `entur`    | `stopPlaces`, `lines`, `authorities`, `keywords`, `url`  | Vy, tog Sande–Oslo       |

| `cisa-kev` | `url` til CISA sin KEV-katalog (JSON)                    | CISA KEV                 |

Alle kilder har `id` (unik, brukes i fil-ID-er), `name`, `short` (merkelapp i
appen) og `group` (gruppering i Kilder-panelet). Sett `"enabled": false` for å
skru en kilde av uten å slette den. For RSS begrenser `maxItems` (standard 200)
hvor mange poster som beholdes fra feeder med mye historikk.

Kilder som ikke kan hentes automatisk: forumet på freak.no (Cloudflare-sperre
mot roboter) og Citrix' sikkerhetsbulletiner (siden bygges med JavaScript og har
ingen feed).

## Bok-påminnelser

`books.json` (og filene den peker til i `include`, f.eks. `books-ledelse.json`)
inneholder korte oppsummeringer av poeng og teknikker fra bøker. Appen fletter
dem inn tilfeldig mellom innleggene. Frekvensen styres i Kilder-panelet som maks
og minst antall kort per 100 innlegg (standard 10 og 3). Hver bok kan slås av
for seg. Er det få vanlige innlegg å vise, fylles resten av kortene på etter dem.
Legg til en bok ved å legge til et objekt med `id`, `title`, `authors` og en
liste `cards` med `title` og `body`.

## Kjøre lokalt

```bash
node scripts/fetch.mjs        # henter innhold til data/
node scripts/serve.mjs 8787   # statisk server på http://localhost:8787/
```

Miljøvariabler: `REDDIT_COMMENT_BUDGET` (standard 10 tråder per kjøring),
`INVISION_TOPIC_BUDGET` (20), `RETENTION_DAYS` (60).

## Reddit-tråder (anbefalt oppsett)

Uten pålogging henter skriptet Reddit-innlegg via RSS, og svar via Reddits
kommentar-RSS, som gir svarene flatt og med streng kvote. Fra GitHub Actions er
Reddits tråd-endepunkt (`svc/shreddit`) blokkert. For fulle tråder med
trådstruktur og god kvote:

1. Gå til <https://www.reddit.com/prefs/apps> og velg «create another app».
2. Velg typen **script**, gi den et navn (f.eks. `bedeem`) og en hvilken som helst
   redirect-URI (f.eks. `http://localhost`). Lagre.
3. Kopier **client id** (teksten under appnavnet) og **secret**.
4. I GitHub-repoet: Settings → Secrets and variables → Actions → New repository
   secret. Legg inn `REDDIT_CLIENT_ID` og `REDDIT_CLIENT_SECRET`.

Neste kjøring bruker da det offisielle API-et automatisk.
