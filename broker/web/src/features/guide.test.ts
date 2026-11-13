import { describe, expect, test } from "vitest";

import { BOX, FLOW_IDS, FLOWS, type Flow, arrowLine, arrowsOf, flowById, flowProblems, nodeStates } from "./guide/flows.ts";

describe("the guide's flows", () => {
  test("there is one flow per tab, and each one's data holds together", () => {
    expect(FLOWS.map((f) => f.id)).toEqual([...FLOW_IDS]);
    for (const flow of FLOWS) expect({ flow: flow.id, problems: flowProblems(flow) }).toEqual({ flow: flow.id, problems: [] });
  });

  test("broken data is reported", () => {
    const broken: Flow = {
      ...flowById("trade"),
      nodes: [...flowById("trade").nodes, { id: "spare", name: "Spare", sub: "", x: 2000, y: 60 }],
      steps: [{ from: "you", to: "nowhere", title: "", text: "" }, { to: "broker", title: "", text: "" }],
    };
    expect(flowProblems(broken)).toEqual([
      "step 1 goes to a missing box, nowhere",
      "the first step has an arrow",
      "step 2 has no arrow",
      "boxes never used: exchange, md, spare",
      "box spare is outside the diagram",
    ]);
  });

  test("each arrow is listed once, there and back counted separately", () => {
    // Each distinct arrow once, in the order the steps first use it.
    const trade = arrowsOf(flowById("trade")).map((a) => `${a.from}>${a.to}`);
    expect(trade).toEqual(["you>broker", "broker>exchange", "exchange>broker", "broker>you", "exchange>md", "md>you"]);
  });

  test("arrows run between the edges of the boxes, and a back-and-forth pair sits apart", () => {
    const a = { id: "a", name: "", sub: "", x: 100, y: 50 };
    const b = { id: "b", name: "", sub: "", x: 400, y: 50 };
    // From a's right edge to just short of b's left edge (room for the head).
    expect(arrowLine(a, b, false)).toEqual({ x1: 100 + BOX.width / 2, y1: 50, x2: 400 - BOX.width / 2 - 6, y2: 50 });
    // Each of a pair moves 7 to its own right: there and back are 14 apart.
    expect(arrowLine(a, b, true).y1).toBe(57);
    expect(arrowLine(b, a, true).y1).toBe(43);
    // Straight down leaves from the bottom edge.
    expect(arrowLine(a, { ...a, id: "c", y: 200 }, false)).toEqual({ x1: 100, y1: 50 + BOX.height / 2, x2: 100, y2: 200 - BOX.height / 2 - 6 });
  });

  test("boxes are current, done or later as the story goes", () => {
    const trade = flowById("trade");
    expect(Object.fromEntries(nodeStates(trade, 0))).toEqual({ you: "current", broker: "later", exchange: "later", md: "later" });
    expect(Object.fromEntries(nodeStates(trade, 2))).toEqual({ you: "done", broker: "done", exchange: "current", md: "later" });
    // Back at the broker: the fill. The exchange stays done.
    expect(Object.fromEntries(nodeStates(trade, 3))).toEqual({ you: "done", broker: "current", exchange: "done", md: "later" });
  });

  test("no em dashes in the words", () => {
    for (const flow of FLOWS) {
      for (const text of [flow.summary, ...flow.steps.flatMap((s) => [s.title, s.text])]) expect(text).not.toContain("\u2014");
    }
  });
});
