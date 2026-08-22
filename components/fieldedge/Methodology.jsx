"use client";
import BACKTEST from "@/lib/fantasy/data/backtest.json";
import { DATA_SEASON, N_MULTI, N_SINGLE, SEASONS_USED, UNIVERSE } from "@/lib/fantasy/universe";
import { SectionBar, T } from "./atoms";

function H({ children }) {
  return <div className="display" style={{ fontSize: 15, fontWeight: 700, margin: "10px 0 8px" }}>{children}</div>;
}
function P({ children }) {
  return <p className="body-serif" style={{ margin: "0 0 12px", maxWidth: 640 }}>{children}</p>;
}

const cell = { fontSize: 11.5, padding: "6px 4px", borderBottom: "1px solid " + T.hair };
const th = { ...cell, borderBottom: "1px solid " + T.black, fontWeight: 500, fontSize: 11 };

export default function Methodology() {
  return (
    <div style={{ marginTop: 40, maxWidth: 680 }}>
      <SectionBar num="01" title="Data & Updates" />
      <H>Where the numbers come from</H>
      <P>
        {`Player statistics, weekly game logs, official injury reports (2009 onward), and birthdates come
        from nflverse-data, the open play-by-play project. Market consensus comes from the FantasyPros
        redraft expert-consensus rank (ECR), mirrored daily by the DynastyProcess data project. The
        current universe: ${UNIVERSE.length.toLocaleString()} players who took the field in ${SEASONS_USED[SEASONS_USED.length - 1]};
        ${N_MULTI} carry two or more real seasons (${SEASONS_USED.join(", ")}), ${N_SINGLE} carry one.`}
      </P>
      <H>How the data updates</H>
      <P>
        The dataset is a versioned snapshot committed to the repository and rebuilt by
        <span className="data"> scripts/build-dataset.py</span>. A scheduled GitHub Action re-runs the build
        every Tuesday and Friday morning through draft season and commits the result, so a deployed site
        picks up fresh market consensus automatically; it can also be refreshed by hand at any time with
        <span className="data"> npm run data</span>. Completed-season statistics are final and only the
        ECR snapshot moves day to day. The Player Lab&rsquo;s live sync is the one real-time piece: it
        researches a player&rsquo;s current injury report, weather, and role on demand.
      </P>

      <div style={{ marginTop: 28 }}>
        <SectionBar num="02" title="Season Projection" />
        <H>Five layers, each earning its place</H>
        <P>
          <b>1 · Usage &amp; recency.</b>{" "}Per-game scoring rates from the last three seasons, weighted
          50/30/20 by recency and by games played — an injury-shortened year is thin evidence, not proof
          of decline, and breakouts surface fast.
        </P>
        <P>
          <b>2 · Availability.</b>{" "}Points = rate × expected games, where expected games shrinks the
          player&rsquo;s own history toward the league norm (≈14.5 of 17). Chronic missers project fewer
          games; nobody projects a full 17 on reputation.
        </P>
        <P>
          <b>3 · Age.</b>{" "}Every past rate is re-based through position-specific career curves built on
          real birthdates: RBs decline from ~27, WRs hold to ~29, TEs to ~30, QBs into their mid-30s.
        </P>
        <P>
          <b>4 · Injury comps.</b>{" "}A season of ≤13 games with a named injury is a major-injury season.
          The year-after multiplier is learned from every comparable position × body-part case since
          2010 — empirically: Back 0.84×, Hamstring 0.87×, Knee 0.88×, Achilles 0.92×, most soft-tissue
          ≈1.0× — with thin cells shrunk toward broader pools. Because the backtest shows this barely
          moves averages, it acts mostly by widening the risk band.
        </P>
        <P>
          <b>5 · Market blend.</b>{" "}The model is blended 50/50 with the FantasyPros consensus (ranks
          converted to points through the model&rsquo;s own positional curve). The market encodes
          holdouts, scheme changes, and camp news that statistics cannot see — and the blend is the
          single largest accuracy gain below.
        </P>
      </div>

      <div style={{ marginTop: 28 }}>
        <SectionBar num="03" title="Validation" />
        <H>Backtested on {BACKTEST.targets.length} held-out seasons</H>
        <P>
          {`Each layer predicted seasons ${BACKTEST.targets.join(", ")} using only earlier data, then was
          scored against reality. Rank r is the Spearman correlation between projected and actual season
          points; MAE-36 is the mean error among the top draft-relevant players per position. No layer
          ships unless it survives this table.`}
        </P>
        <table style={{ width: "100%", borderCollapse: "collapse" }} className="data">
          <thead>
            <tr>
              <th style={{ ...th, textAlign: "left" }}>Model layer</th>
              <th style={{ ...th, textAlign: "right" }}>Rank r</th>
              <th style={{ ...th, textAlign: "right" }}>MAE-36</th>
            </tr>
          </thead>
          <tbody>
            {Object.entries(BACKTEST.byVariant).map(([v, b]) => (
              <tr key={v}>
                <td style={{ ...cell, fontWeight: v === "4" ? 700 : 400 }}>{b.label}</td>
                <td style={{ ...cell, textAlign: "right", fontWeight: v === "4" ? 700 : 400 }}>{b.overall.spearman.toFixed(3)}</td>
                <td style={{ ...cell, textAlign: "right", fontWeight: v === "4" ? 700 : 400 }}>{b.overall.maeTop.toFixed(1)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <P>
          The bolded row is what ships. An honest ceiling: the best public projections correlate with
          reality at roughly this level; the remaining gap is mostly unforecastable — injuries and role
          shocks. What a good model buys is calibration, not clairvoyance.
        </P>
      </div>

      <div style={{ marginTop: 28 }}>
        <SectionBar num="04" title="Risk" />
        <H>Two kinds of disagreement</H>
        <P>
          Risk averages two z-scored signals within each position: how much a player&rsquo;s own seasons
          disagree with each other, and how much the experts disagree about his rank. The blend is
          rescaled to mean 5, sd 2 — under 4 reads as a stable starter, 6+ as boom-or-bust — then widened
          further for anyone returning from a major injury.
        </P>
      </div>

      <div style={{ marginTop: 28 }}>
        <SectionBar num="05" title="Draft Board & Optimizer" />
        <H>Value over replacement</H>
        <P>
          VOR is projected points above a waiver-wire replacement starter — the empirical average of the
          players actually holding the replacement rank (±1) at each position, with ranks scaled to your
          league size. The optimal-roster tool solves the lineup exactly under a per-player risk cap,
          and the frontier shows what each notch of risk tolerance buys.
        </P>
      </div>

      <div style={{ marginTop: 28 }}>
        <SectionBar num="06" title="Draft Room" />
        <H>Your seat, simulated forward</H>
        <P>
          Given your league size and slot, opponents are assumed to draft the best available player by
          market consensus, with light roster sense (no second QB or TE early; kickers late). At each of
          your picks, every serious candidate is evaluated by simulating the <i>entire remaining
          draft</i> — opponents by consensus, your future turns filled greedily by marginal roster
          value — and candidates are ranked by the final projected value of your completed roster:
          starters at full projection, bench at a steep discount above replacement. &ldquo;Cost of
          waiting&rdquo; is the points you give up at a position by passing until your next turn — the
          quantity that decides positional runs. Every real pick you record overwrites the assumption
          for that slot and the whole plan re-optimizes. Connected to an ESPN league, the room mirrors
          the real draft: the server polls ESPN&rsquo;s league API every 2.5 seconds (auth cookies never
          leave the server), maps each selection to the model by ESPN player id, and recomputes on every
          new pick — including P(next), the probability a candidate survives to your next turn under a
          Normal(consensus rank, expert-disagreement) selection model.
        </P>
      </div>

      <div style={{ marginTop: 28 }}>
        <SectionBar num="07" title="Weekly What-If Lab" />
        <H>Monte Carlo around a per-game baseline</H>
        <P>
          The lab divides the season projection per expected game and simulates 6,000 outcomes using the
          player&rsquo;s observed week-to-week volatility. Factors — settable by hand or auto-filled by
          the live web sync: injury status (chance of playing, effectiveness, wider variance), an age
          what-if, wind/precipitation/dome scaled by positional sensitivity, opponent defensive rank,
          the Vegas implied total, game script, snap share, and the {DATA_SEASON} role outlook (team
          change, depth chart, new competition).
        </P>
      </div>

      <div style={{ marginTop: 28 }}>
        <SectionBar num="08" title="Known Limits" />
        <H>What this does not model</H>
        <P>
          No schedule-strength adjustment; no touchdown-regression term; rookies with zero NFL games
          enter only through their market rank; and the role/depth-chart factor lives in the weekly lab,
          not the season number. Model estimates are probabilistic — the risk column and the lab&rsquo;s
          floor/ceiling bands are as much the product as the point projection.
        </P>
      </div>
    </div>
  );
}
