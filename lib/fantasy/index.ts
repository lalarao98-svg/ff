import rawData from "./data/projections.json";
import type { ProjectionDataset } from "./types";

export * from "./types";
export * from "./scoring";
export * from "./stats";
export { buildProjections, assignTiers } from "./engine";
export { optimizeRoster } from "./optimizer";
export type { OptimizerOptions } from "./optimizer";

/** Bundled 2015 multi-source projection dataset from FantasyFootballAnalyticsR. */
export const DATASET = rawData as unknown as ProjectionDataset;
