// Filesystem wrappers for calibration snapshots.
//
// Kept apart from the pure module so the encoder/decoder stays importable
// anywhere, while anything touching `fs` is confined to a `.server` file that
// never reaches a client bundle.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import {
  parseCalibrationSnapshot,
  serialiseCalibrationSnapshot,
  type CalibrationSnapshot,
} from "./execution-correlation-snapshot";

/** Writes the snapshot as pretty JSON, creating the directory if needed. */
export function saveCalibrationSnapshotFile(path: string, snap: CalibrationSnapshot): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, serialiseCalibrationSnapshot(snap), "utf8");
}

/** Reads and validates a snapshot; throws with the path on a bad file. */
export function loadCalibrationSnapshotFile(path: string): CalibrationSnapshot {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    throw new Error(`Cannot read calibration snapshot ${path}: ${(err as Error).message}`);
  }
  try {
    return parseCalibrationSnapshot(raw);
  } catch (err) {
    throw new Error(`Invalid calibration snapshot ${path}: ${(err as Error).message}`);
  }
}
