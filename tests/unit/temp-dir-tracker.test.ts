import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { TempDirTracker } from "./helpers";

describe("TempDirTracker (#501)", () => {
  const tracker = new TempDirTracker();

  afterEach(() => {
    tracker.cleanup();
  });

  it("tracks and removes directories on cleanup", () => {
    const dir = tracker.track(fs.mkdtempSync(path.join(os.tmpdir(), "tracker-test-")));
    expect(fs.existsSync(dir)).toBe(true);
    expect(tracker.has(dir)).toBe(true);
    expect(tracker.size).toBe(1);

    tracker.cleanup();

    expect(fs.existsSync(dir)).toBe(false);
    expect(tracker.has(dir)).toBe(false);
    expect(tracker.size).toBe(0);
  });

  it("never deletes a directory that was not tracked", () => {
    const callerOwnedDir = fs.mkdtempSync(path.join(os.tmpdir(), "caller-owned-"));
    const trackedDir = tracker.track(fs.mkdtempSync(path.join(os.tmpdir(), "tracked-")));

    try {
      expect(tracker.has(callerOwnedDir)).toBe(false);
      expect(tracker.has(trackedDir)).toBe(true);

      tracker.cleanup();

      // Tracked directory must be deleted, caller-owned must survive
      expect(fs.existsSync(trackedDir)).toBe(false);
      expect(fs.existsSync(callerOwnedDir)).toBe(true);
    } finally {
      fs.rmSync(callerOwnedDir, { recursive: true, force: true });
    }
  });

  it("handles cleanup gracefully when a directory was already removed manually", () => {
    const dir = tracker.track(fs.mkdtempSync(path.join(os.tmpdir(), "tracker-manual-")));
    fs.rmSync(dir, { recursive: true, force: true });
    expect(fs.existsSync(dir)).toBe(false);

    expect(() => tracker.cleanup()).not.toThrow();
    expect(tracker.size).toBe(0);
  });

  // #599: the three cases above all pre-delete a single directory. Nothing
  // here covered a *batch* where one entry is already gone, an entry whose
  // contents cannot be unlinked, or the risk that a cleanup broadening its
  // own scope would sweep a sibling the tracker never registered. Every
  // directory below is created inside a per-test base directory so the
  // assertions never depend on what else the system temp directory holds.
  describe("negative cleanup conditions (#599)", () => {
    let baseDir: string;
    /** Directories whose mode was lowered so the test can restore them. */
    let locked: string[];

    beforeEach(() => {
      baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "tracker-negative-"));
      locked = [];
    });

    afterEach(() => {
      // A read-only directory cannot be unlinked from its parent until the
      // mode is restored; put it back before removing the base. Skipping a
      // directory that is already gone is not a Windows special case: a
      // runner that ignores mode bits (root on POSIX, anything on NTFS)
      // deletes it during cleanup, and chmod on the missing path would throw
      // out of the hook and fail the test for the wrong reason.
      for (const dir of locked) {
        if (fs.existsSync(dir)) {
          fs.chmodSync(dir, 0o755);
        }
      }
      fs.rmSync(baseDir, { recursive: true, force: true });
    });

    /** A tracked directory under the per-test base, uniquely named. */
    function makeTracked(name: string): string {
      const dir = path.join(baseDir, name);
      fs.mkdirSync(dir);
      fs.writeFileSync(path.join(dir, "payload.txt"), `${name}\n`);
      return tracker.track(dir);
    }

    it("removes the surviving directories when one of several was pre-deleted", () => {
      const first = makeTracked("first");
      const second = makeTracked("second");
      const third = makeTracked("third");

      // An external process deletes one of the three before cleanup runs.
      fs.rmSync(second, { recursive: true, force: true });
      expect(tracker.size).toBe(3);

      expect(() => tracker.cleanup()).not.toThrow();

      // One missing entry must not abort the pass over the rest.
      expect(fs.existsSync(first)).toBe(false);
      expect(fs.existsSync(third)).toBe(false);
      expect(tracker.size).toBe(0);
      expect(tracker.has(first)).toBe(false);
      expect(tracker.has(second)).toBe(false);
      expect(tracker.has(third)).toBe(false);
    });

    it("does not throw when a tracked directory's contents cannot be removed", () => {
      const dir = makeTracked("unwritable");
      // Remove write permission on the directory itself: unlinking the file
      // inside it now fails, so cleanup cannot complete for this entry.
      fs.chmodSync(dir, 0o500);
      locked.push(dir);

      expect(() => tracker.cleanup()).not.toThrow();

      // The load-bearing assertion is the bookkeeping, not the outcome of
      // the unlink: a runner executing as root (which ignores the mode) and
      // a runner that honoured it must both end with an empty tracking list.
      expect(tracker.size).toBe(0);
      expect(tracker.has(dir)).toBe(false);
    });

    it("leaves an untracked sibling of a pre-deleted directory alone", () => {
      const sibling = path.join(baseDir, "caller-owned");
      fs.mkdirSync(sibling);
      fs.writeFileSync(path.join(sibling, "keep.txt"), "do not delete\n");

      const tracked = makeTracked("tracked");
      fs.rmSync(tracked, { recursive: true, force: true });

      expect(() => tracker.cleanup()).not.toThrow();

      // Cleanup tolerates the missing entry by dropping it, never by
      // deleting the surrounding directory to make the state consistent.
      expect(fs.existsSync(sibling)).toBe(true);
      expect(fs.readFileSync(path.join(sibling, "keep.txt"), "utf8")).toBe("do not delete\n");
      expect(tracker.size).toBe(0);
    });
  });
});
