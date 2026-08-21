import Anthropic from "@anthropic-ai/sdk";
import { NextResponse } from "next/server";

export const maxDuration = 60;

/* Live injury/weather/Vegas report for one player, via Claude + web search.
 * Requires ANTHROPIC_API_KEY in the server environment. */
export async function POST(req: Request) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json(
      { error: "Live sync is not configured: set ANTHROPIC_API_KEY on the server." },
      { status: 501 },
    );
  }

  let name: string, pos: string, team: string;
  try {
    ({ name, pos, team } = await req.json());
    if (typeof name !== "string" || !name.trim()) throw new Error();
  } catch {
    return NextResponse.json({ error: "Expected JSON body with name, pos, team." }, { status: 400 });
  }

  const prompt =
    `Search the web for the latest information relevant to NFL player ${name} (${pos}, ${team}) ` +
    `for their upcoming game: current injury report status, expected stadium weather (wind mph, rain/snow), ` +
    `whether the game is in a dome, opponent defensive rank vs his position (1 = toughest of 32), ` +
    `and the Vegas implied team total. Respond with ONLY minified JSON, no markdown fences, exactly this shape: ` +
    `{"injuryStatus":"healthy"|"probable"|"questionable"|"doubtful"|"out","windMph":number,` +
    `"precip":"none"|"rain"|"snow","dome":boolean,"oppDefRank":number,"teamTotal":number,` +
    `"note":"one short sentence summary"}`;

  try {
    const client = new Anthropic();
    const response = await client.beta.messages.create({
      model: "claude-opus-5",
      max_tokens: 16000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      tools: [{ type: "web_search_20260209", name: "web_search", max_uses: 5 }],
      messages: [{ role: "user", content: prompt }],
    });

    if (response.stop_reason === "refusal") {
      return NextResponse.json({ error: "The model declined this lookup." }, { status: 502 });
    }

    const text = response.content
      .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n");
    const clean = text.replace(/```json|```/g, "").trim();
    const start = clean.indexOf("{");
    const end = clean.lastIndexOf("}");
    if (start === -1 || end <= start) {
      return NextResponse.json({ error: "No report JSON in model response." }, { status: 502 });
    }
    return NextResponse.json(JSON.parse(clean.slice(start, end + 1)));
  } catch (err) {
    const message = err instanceof Anthropic.APIError ? err.message : "Live sync failed.";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
