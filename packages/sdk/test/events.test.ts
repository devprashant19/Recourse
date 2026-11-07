import { describe, expect, it } from "vitest";

import { EVENT_NAMES, parseEvent, parseEvents } from "../src/events.js";

const line = (body: unknown) => `EVENT_JSON:${JSON.stringify(body)}`;

describe("parseEvent", () => {
  it("parses a well-formed Recourse event", () => {
    const e = parseEvent(
      line({ standard: "recourse", version: "1.0.0", event: "bond_posted", data: [{ agent: "a.near", amount: "5" }] }),
    );
    expect(e?.event).toBe("bond_posted");
    expect(e?.data[0]?.amount).toBe("5");
  });

  it("ignores other standards, plain logs, bad JSON and unknown events", () => {
    expect(parseEvent("hello")).toBeNull();
    expect(parseEvent("EVENT_JSON:{not json")).toBeNull();
    expect(parseEvent(line({ standard: "nep171", version: "1.0.0", event: "nft_mint", data: [] }))).toBeNull();
    expect(parseEvent(line({ standard: "recourse", version: "1.0.0", event: "drain_vault", data: [] }))).toBeNull();
    expect(parseEvent(line({ standard: "recourse", version: "1.0.0", event: "paused", data: "x" }))).toBeNull();
  });

  it("keeps order and drops non-events in a log list", () => {
    const logs = [
      "noise",
      line({ standard: "recourse", version: "1.0.0", event: "claim_filed", data: [{}] }),
      line({ standard: "recourse", version: "1.0.0", event: "slashed", data: [{}] }),
    ];
    expect(parseEvents(logs).map((e) => e.event)).toEqual(["claim_filed", "slashed"]);
  });

  it("knows exactly the event names the contract emits", () => {
    expect(new Set(EVENT_NAMES).size).toBe(EVENT_NAMES.length);
    expect(EVENT_NAMES).toContain("engagement_accepted");
    expect(EVENT_NAMES).toContain("claim_timed_out");
  });
});
