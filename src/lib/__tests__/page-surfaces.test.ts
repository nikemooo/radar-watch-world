import { describe, expect, it } from "vitest";
import { parseStructured } from "@/lib/monitoring/enrichment";

const PAGE = "https://example.se/bostad/14a";

describe("generic listing page surfaces", () => {
  it("preserves metadata, headings, feature lists, specs and image text", () => {
    const html = `
      <html><head>
        <meta name="description" content="Ljus bostad med utsikt över Saltsjön">
        <meta property="og:description" content="Finnboda Hamn, Nacka">
      </head><body>
        <h1>Finnboda varvsväg 14A, Nacka</h1>
        <h2>Beskrivning</h2>
        <ul><li>Stor balkong</li><li>Utsikt över Saltsjön</li></ul>
        <dl><dt>Adress</dt><dd>Finnboda varvsväg 14A, Nacka</dd></dl>
        <figure><img src="/media/home.jpg" alt="Utsikt från vardagsrummet"><figcaption>Vy över vattnet</figcaption></figure>
      </body></html>`;
    const parsed = parseStructured(html, PAGE);
    expect(parsed.description).toContain("Finnboda Hamn");
    expect(parsed.headings).toContain("Finnboda varvsväg 14A, Nacka");
    expect(parsed.features).toContain("Utsikt över Saltsjön");
    expect(parsed.fields["adress"]).toContain("Nacka");
    expect(parsed.image_text).toEqual(expect.arrayContaining(["Utsikt från vardagsrummet", "Vy över vattnet"]));
  });
});