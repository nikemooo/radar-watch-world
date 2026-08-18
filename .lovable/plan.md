# Radar — slutlig hårdning: geografi, källprioritet, hastighet, UI

Målet: rätt annonser, rätt marknad, rätt länk, rätt bild — snabbt, billigt, och sedan
kontinuerlig bevakning. Inga kriterier försvagas, inga fakta gissas, ingen seed-data.

Arbetet delas i fem etapper. Efter varje etapp: tester + typecheck. Live-sweepar körs
bara i etapp 5 (kostnad), och då en gång per radar.

## Etapp 1 — Geografi och källprioritet (högst prio)

**Geografisk relevans**
- Ny modul `src/lib/monitoring/geo.ts`: härleder marknadstillhörighet från explicit
  evidens — källans TLD/host-marknad, adress/ort i JSON-LD eller sidtext, säljarens
  land, språk. Valuta får aldrig ensam bevisa geografi, men räknas som stödjande.
- Kriteriegaten får ett `country`-krav när radarns config anger marknad. Utfall:
  verifierat fel land → `reject`; okänt → `unverified`; verifierat rätt → passerar.
- Utländska listningar kan alltså aldrig hamna i "Matchar", bara i "Behöver verifieras"
  eller "Matchar inte".

**Source priority-motor**
- Ny modul `src/lib/search/source-priority.server.ts`. Generisk (ingen hårdkodad
  Blocket-logik): poängsätter en host på kategori-, land-, språk- och valutasignaler
  plus *inlärd* historik från `source_fetch_stats` (utökas med relevans, inventory-
  densitet, extraction-rate, duplicate-rate, blocked-rate per host + kategori).
- Query-planner och index-expansion konsumerar prioriteten: primärkällor får
  reserverade budgetplatser och söks först; brus sist.
- Källor som levererar verifierade, aktuella objekt stiger; katalog/editorial/asset-
  familjer sjunker. Diversitet bevaras via en fast andel utforskande platser.

## Etapp 2 — Hastighet, partiella resultat, kostnad

- Parallellisera oberoende sökningar och detaljhämtningar med per-host-spridning och
  befintlig backoff/cost-ceiling intakt.
- Early stopping: sluta expandera en källa när täckningen räcker; sluta paginera när
  inga nya item-URL:er hittas. Logga stoppskäl.
- Findings persisteras löpande under sweepen istället för i ett slutblock, så UI kan
  strömma in resultat. `monitor_runs` får `first_useful_result_at`.
- Lägen: `SNABB` respektive `DJUP` på radarn styr budgetar, pagineringsdjup och
  antal källor — aldrig kriterier.
- Cache av redan lästa sidor inom en sweep; dedup före dyra detaljhämtningar;
  deterministisk extraction före AI (redan på plats, verifieras).

## Etapp 3 — Bilder, länkar, missning-telemetri

- Bilder: enrichment plockar `images[]` från JSON-LD, OpenGraph, gallerimarkup,
  meta och index-kort, alltid bundna till samma listing-identity. Provenance sparas.
  UI får en neutral placeholder när bild saknas.
- `primary_url` = den faktiska item-URL:en; `discovery_url` = indexsidan. Verifieras
  för Blocket-item-URL:er.
- Missning-telemetri: varje upptäckt item-URL loggas med livscykelstatus (sedd i
  sökresultat / sedd på indexsida / paginerad fram / filtrerad bort med skäl /
  blockerad / vald). Gör det möjligt att skilja "källan hade den inte" från
  "vi filtrerade bort den".

## Etapp 4 — Lägen, schemaläggning, redigering, UI

- Radar-lägen `find_and_watch` (Mode A, standard för annons-/produktsökningar) och
  `monitor_market` (Mode B). Tydligt i skapande-flödet och på detaljsidan.
- Startval vid skapande: **Starta direkt**, **Schemalägg** (datum/tid i användarens
  tidszon, Pro Plus) eller **Starta manuellt**. Nya scan-states:
  `draft`, `initial_scan_pending`, `initial_scan_scheduled`, `initial_scan_running`,
  `monitoring`, `failed`, `paused`. Stale-run-recovery behålls.
- "Sök nu" är alltid explicit och deterministiskt skyddad mot dubbelkörning.
- Redigera radar: ändra text/kriterier/land/pris/frekvens. Kriterier versioneras
  (`radar_criteria_versions`) så historik och tidigare observationer bevaras;
  findings taggas med den kriterieversion de bedömdes mot.
- UI förenklas: tre sektioner (Matchar / Behöver verifieras / Matchar inte),
  lugna kort med bild, pris, nyckelfakta, marknadsomdöme, källa och direktlänk.
  All telemetri hamnar under "Teknisk information" längst ner. Mobil swipe-rail
  förenklas kraftigt. Progressen visas i klarspråk ("Söker Blocket…",
  "7 annonser verifierade").

## Etapp 5 — Verifiering med riktiga data

- Regressionssviten utökas: source prioritization, country/currency-relevans,
  direct listing URL, index-card provenance, bildextraktion och provenance,
  unverified-bucket, kriterieversionering, schemaläggning, run-now-override,
  stale-run recovery, fast/deep mode, early stopping.
- Production build + typecheck + migrationer + hela testsviten.
- En live end-to-end-sweep på BMW M340i xDrive (Sverige, svart, 2021+, max 600 000 SEK)
  och en på Rolex Submariner 124060 (Sverige, max 120 000 SEK). Rapport med tid,
  time-to-first-useful-result, källor, kandidater, matchningar, unverified, rejected,
  bilder, direktlänkar, Blocket-träffar (inkl. de kända ~519k och ~549k), paginering,
  kostnad, fel och slutstatus.

## Tekniska noter

- Migrationer: nya kolumner på `radars` (mode, speed, scheduling, scan-states),
  `monitor_runs` (`first_useful_result_at`, missning-telemetri), ny tabell för
  kriterieversioner, utökad `source_fetch_stats` med kategori/kvalitetsmått.
  Alla nya publika tabeller får GRANT + RLS.
- Ingen ändring av deterministisk criteria gate, identity fingerprints, duplicate-
  suppression, recency, price-change-detection, comparable/currency-segregation,
  anti-fabrication, provenance, host backoff eller cost ceiling — dessa testas som
  regressioner.
