# Lägg till Lite-nivån

## Resultat
- Lägg till Lite mellan Free och Plus: 149 kr/mån och årspris motsvarande tio månadsbetalningar.
- Skapa motsvarande priser i SEK, USD, EUR, GBP, CAD och AUD enligt befintlig marknadsmodell.
- Sätt gränserna till 3 radars, ett svep per dygn, 15 larm per månad, full detaljhämtning och 14 dagars historik.
- Använd standardfiltret Medel, Stor och Extremt stor för nya Lite-radars.

## Prissida och betalning
- Visa Lite som en egen nivå mellan Free och Plus på både prissidan och betalningssidan.
- Behåll Plus som markerad populär nivå.
- Gör 15 kontra obegränsade larm och 14 kontra 30 dagars historik tydliga i korten.
- Säkerställ korrekt upp-/nedgraderingsordning mellan alla fem nivåer.

## Verifiering
- Kontrollera att samtliga sex marknader har både månads- och årspris.
- Kontrollera svenska och engelska prisvyer samt skillnaderna mellan Lite och Plus.
- Kontrollera att betalningsvalet hittar rätt Lite-pris och att projektet bygger utan fel.

## Tekniskt
- Lägg till planen och priserna genom en databasändring med befintliga åtkomstregler.
- Skapa betalningsprodukt och återkommande priser i den redan konfigurerade betalningsmiljön och lagra deras pris-ID:n.
- Uppdatera planrankning och markeringslogik utan att ändra övriga nivåers villkor.
