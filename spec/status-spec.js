const { StatusPanel } = require("../lib/status");
const { Front } = require("../lib/front");
const { fakeHub, SEVERITIES } = require("./fake-hub");

// Counters follow the hub's severity vocabulary. An empty snapshot keeps a
// neutral panel control without claiming that a provider completed a check.
describe("lib/status", () => {
  let status;
  let front;
  let messages;
  let lintingDisabled;

  const message = (severity) => ({ severity, excerpt: severity, location: { file: "/a.js" } });

  const tileFor = (severity) => status.counters.find((tile) => tile.severity.name === severity);
  const isHidden = (severity) =>
    tileFor(severity).counter.classList.contains("linter-status-counter-hidden");
  const visibleSeverities = () =>
    status.counters
      .filter(({ severity }) => !isHidden(severity.name))
      .map(({ severity }) => severity.name);
  const tooltipTitle = () => lumine.tooltips.findTooltips(status.element)[0].getTitle();

  beforeEach(() => {
    messages = [];
    lintingDisabled = false;
    lumine.config.set("linter-panel.statusMode", true);
    front = new Front();
    // Whether linting is disabled is a question about an editor's buffer.
    const editor = {};
    const hub = fakeHub({ messages: () => messages, editor: () => editor });
    hub.isLintingDisabled = () => lintingDisabled;
    front.attach(hub);
    status = new StatusPanel(front);
    front.status = status;
  });

  afterEach(() => {
    status.destroy();
    front.dispose();
  });

  it("builds one tile per severity, in precedence order", () => {
    expect(status.counters.map((tile) => tile.severity.name)).toEqual([
      "error",
      "warning",
      "info",
      "hint",
    ]);
    expect(tileFor("hint").counter.querySelector(".icon").classList).toContain("icon-light-bulb");
  });

  it("describes the message count and primary action in the current scope", () => {
    expect(status.projectIcon.hidden).toBe(true);
    expect(tooltipTitle()).toBe("File diagnostics: no messages. Click to toggle the panel.");
    messages = [message("warning")];
    front.render({ messages });
    expect(tooltipTitle()).toBe("File diagnostics: 1 message. Click to toggle the panel.");
    messages = [message("warning"), message("hint")];
    front.render({ messages });
    expect(tooltipTitle()).toBe("File diagnostics: 2 messages. Click to toggle the panel.");
    front.setViewMode("project");
    expect(status.projectIcon.hidden).toBe(false);
    expect(status.projectIcon.classList).toContain("icon-file-directory");
    expect(tooltipTitle()).toBe("Project diagnostics: 2 messages. Click to toggle the panel.");
    messages = [];
    front.render({ messages });
    expect(tooltipTitle()).toBe("Project diagnostics: no messages. Click to toggle the panel.");
    expect(status.projectIcon.hidden).toBe(false);
    front.setViewMode("file");
    expect(status.projectIcon.hidden).toBe(true);
  });

  it("keeps a neutral status-bar control before the hub or an editor exists", () => {
    const tile = { destroy: jasmine.createSpy("destroy") };
    const statusBar = {
      addLeftTile: jasmine.createSpy("addLeftTile").and.returnValue(tile),
    };
    const noEditorFront = new Front();
    const noEditorStatus = new StatusPanel(noEditorFront, statusBar);
    noEditorFront.status = noEditorStatus;

    expect(statusBar.addLeftTile).toHaveBeenCalledWith({ item: noEditorStatus, priority: 210 });
    expect(noEditorStatus.counters.map((entry) => entry.severity.name)).toEqual([
      "error",
      "warning",
      "info",
      "hint",
    ]);
    for (const { counter, label } of noEditorStatus.counters) {
      expect(counter.classList).toContain("linter-status-counter-hidden");
      expect(label.textContent).toBe("0");
    }
    expect(noEditorStatus.stateIcon.hidden).toBe(false);
    expect(noEditorStatus.stateIcon.classList).toContain("icon-checklist");
    const [tooltip] = lumine.tooltips.findTooltips(noEditorStatus.element);
    expect(tooltip.getTitle()).toBe("Diagnostics unavailable. Click to toggle the panel.");

    noEditorStatus.setEditor({});
    noEditorStatus.setEditor(null);
    expect(statusBar.addLeftTile).toHaveBeenCalledTimes(1);

    noEditorStatus.destroy();
    expect(tile.destroy).toHaveBeenCalledTimes(1);
    noEditorFront.dispose();
  });

  it("counts each severity into its own tile", () => {
    messages = [message("error"), message("hint"), message("hint"), message("warning")];
    status.update();
    expect(tileFor("error").label.textContent).toBe("1");
    expect(tileFor("warning").label.textContent).toBe("1");
    expect(tileFor("info").label.textContent).toBe("0");
    expect(tileFor("hint").label.textContent).toBe("2");
    expect(visibleSeverities()).toEqual(["error", "warning", "hint"]);
    expect(status.stateIcon.hidden).toBe(true);
  });

  it("replaces all zero counters with one neutral icon and restores it after messages clear", () => {
    expect(visibleSeverities()).toEqual([]);
    expect(status.stateIcon.hidden).toBe(false);
    expect(status.stateIcon.classList).toContain("icon-checklist");

    messages = [message("info")];
    front.render({ messages });
    expect(visibleSeverities()).toEqual(["info"]);
    expect(status.stateIcon.hidden).toBe(true);

    messages = [];
    front.render({ messages });
    expect(visibleSeverities()).toEqual([]);
    expect(status.stateIcon.hidden).toBe(false);
    expect(status.stateIcon.classList).toContain("icon-checklist");
  });

  it("returns to an unavailable neutral state when the hub detaches and restores on attach", () => {
    messages = [message("warning")];
    front.render({ messages });
    const hub = front.hub;

    front.detach();
    expect(visibleSeverities()).toEqual([]);
    expect(status.stateIcon.hidden).toBe(false);
    expect(status.stateIcon.classList).toContain("icon-checklist");
    expect(tooltipTitle()).toBe("Diagnostics unavailable. Click to toggle the panel.");

    front.attach(hub);
    expect(visibleSeverities()).toEqual(["warning"]);
    expect(status.stateIcon.hidden).toBe(true);
    expect(tooltipTitle()).toBe("File diagnostics: 1 message. Click to toggle the panel.");
  });

  it("ignores a severity outside the model rather than miscounting it", () => {
    messages = [message("boom")];
    status.update();
    for (const tile of status.counters) {
      expect(tile.label.textContent).toBe("0");
    }
  });

  it("colors a tile only while it has something to report", () => {
    status.update();
    expect(tileFor("error").counter.classList).not.toContain("text-error");
    messages = [message("error")];
    status.update();
    expect(tileFor("error").counter.classList).toContain("text-error");
  });

  it("reuses current-file counts for an unchanged snapshot", () => {
    const severity = jasmine.createSpy("severity").and.returnValue("error");
    const diagnostic = message("error");
    Object.defineProperty(diagnostic, "severity", { get: severity });
    messages = [diagnostic];
    status.update();
    severity.calls.reset();

    status.update();

    expect(severity).not.toHaveBeenCalled();
    expect(tileFor("error").label.textContent).toBe("1");
  });

  it("updates project tallies from deltas without recounting unchanged messages", () => {
    const severity = jasmine.createSpy("severity").and.returnValue("error");
    const error = message("error");
    Object.defineProperty(error, "severity", { get: severity });
    const warning = message("warning");
    messages = [error, warning];
    front.render({ messages });
    front.setViewMode("project");
    severity.calls.reset();
    const hint = message("hint");
    messages = [error, hint];

    front.render({ added: [hint], removed: [warning], messages });

    expect(severity).not.toHaveBeenCalled();
    expect(tileFor("error").label.textContent).toBe("1");
    expect(tileFor("warning").label.textContent).toBe("0");
    expect(tileFor("hint").label.textContent).toBe("1");
  });

  it("keeps project counts across metadata-only replacement objects", () => {
    const original = message("warning");
    messages = [original];
    front.render({ messages });
    front.setViewMode("project");
    const severity = jasmine.createSpy("severity").and.returnValue("warning");
    const replacement = { ...original, description: "updated details" };
    Object.defineProperty(replacement, "severity", { get: severity });
    messages = [replacement];

    front.render({ added: [], removed: [], updated: [replacement], messages });

    expect(severity).not.toHaveBeenCalled();
    expect(tileFor("warning").label.textContent).toBe("1");
  });

  it("recounts a full snapshot when the hub omits deltas", () => {
    messages = [message("warning")];
    front.render({ messages });
    front.setViewMode("project");
    messages = [message("error"), message("error")];

    front.render({ messages });

    expect(tileFor("warning").label.textContent).toBe("0");
    expect(tileFor("error").label.textContent).toBe("2");
  });

  it("recounts when delta lengths do not describe the full snapshot", () => {
    messages = [message("warning")];
    front.render({ messages });
    front.setViewMode("project");
    messages = [message("error"), message("error")];

    front.render({ added: [], removed: [], messages });

    expect(tileFor("warning").label.textContent).toBe("0");
    expect(tileFor("error").label.textContent).toBe("2");
  });

  it("recounts a current snapshot reused by an older hub without deltas", () => {
    messages = [message("warning")];
    status.update();
    messages[0] = message("error");

    front.render({ messages });

    expect(tileFor("warning").label.textContent).toBe("0");
    expect(tileFor("error").label.textContent).toBe("1");
  });

  it("recounts if a removal delta refers to an empty severity bucket", () => {
    messages = [message("warning")];
    front.render({ messages });
    front.setViewMode("project");
    const error = message("error");
    messages = [error];

    front.render({ added: [error], removed: [message("info")], messages });

    expect(tileFor("warning").label.textContent).toBe("0");
    expect(tileFor("error").label.textContent).toBe("1");
    expect(tileFor("info").label.textContent).toBe("0");
  });

  it("takes current-file counts again after switching away from project mode", () => {
    const own = message("warning");
    messages = [own, message("error")];
    front.hub.getCurrentMessages = () => [own];
    front.render({ messages });
    front.setViewMode("project");
    expect(tileFor("error").label.textContent).toBe("1");

    front.setViewMode("file");

    expect(tileFor("error").label.textContent).toBe("0");
    expect(tileFor("warning").label.textContent).toBe("1");
  });

  it("accepts a replaced severity vocabulary of the same size", () => {
    messages = [message("constructor"), message("constructor")];
    const hub = fakeHub({ messages: () => messages });
    hub.getSeverities = () =>
      SEVERITIES.map((severity, index) =>
        index === 0 ? { ...severity, name: "constructor", label: "Constructor" } : severity,
      );

    front.attach(hub);

    expect(tileFor("error")).toBeUndefined();
    expect(tileFor("constructor").label.textContent).toBe("2");
    expect(tileFor("warning").label.textContent).toBe("0");
  });

  describe("disabled file linting", () => {
    it("shows one disabled icon with no zero counters or X labels", () => {
      lintingDisabled = true;
      status.update();
      expect(visibleSeverities()).toEqual([]);
      for (const { label } of status.counters) expect(label.textContent).toBe("0");
      expect(status.stateIcon.hidden).toBe(false);
      expect(status.stateIcon.classList).toContain("icon-circle-slash");
      expect(status.stateIcon.classList).not.toContain("icon-checklist");
      expect(status.element.classList).toContain("linting-disabled");
      expect(tooltipTitle()).toBe(
        "File diagnostics: linting disabled for this file. Click to toggle the panel.",
      );
    });

    it("keeps nonzero counts muted beside the disabled icon and restores them when enabled", () => {
      messages = [message("error"), message("hint")];
      front.render({ messages });
      lintingDisabled = true;
      status.update();

      expect(visibleSeverities()).toEqual(["error", "hint"]);
      expect(tileFor("error").label.textContent).toBe("1");
      expect(tileFor("hint").label.textContent).toBe("1");
      for (const { severity, counter } of status.counters) {
        expect(counter.classList).not.toContain(severity.textClass);
      }
      expect(status.stateIcon.hidden).toBe(false);
      expect(status.stateIcon.classList).toContain("icon-circle-slash");

      lintingDisabled = false;
      status.update();
      expect(status.stateIcon.hidden).toBe(true);
      expect(status.stateIcon.classList).not.toContain("icon-circle-slash");
      expect(status.element.classList).not.toContain("linting-disabled");
      expect(tileFor("error").counter.classList).toContain("text-error");
      expect(tileFor("hint").counter.classList).toContain("text-hint");
    });

    it("keeps project counts and color independent of disabled linting in the active file", () => {
      messages = [message("error"), message("warning")];
      front.render({ messages });
      lintingDisabled = true;
      front.setViewMode("project");

      expect(visibleSeverities()).toEqual(["error", "warning"]);
      expect(status.element.classList).not.toContain("linting-disabled");
      expect(status.stateIcon.hidden).toBe(true);
      expect(tileFor("error").counter.classList).toContain("text-error");
      expect(tileFor("warning").counter.classList).toContain("text-warning");
      expect(tooltipTitle()).toBe("Project diagnostics: 2 messages. Click to toggle the panel.");

      messages = [];
      front.render({ messages });
      expect(status.stateIcon.hidden).toBe(false);
      expect(status.stateIcon.classList).toContain("icon-checklist");
      expect(status.stateIcon.classList).not.toContain("icon-circle-slash");
      expect(tooltipTitle()).toBe("Project diagnostics: no messages. Click to toggle the panel.");
    });
  });

  describe("optional visibility", () => {
    beforeEach(() => {
      lumine.config.set("linter-panel.statusMode", false);
    });

    it("hides an empty enabled state and stays visible for hint-only messages", () => {
      expect(status.element.classList).toContain("linter-status-hidden");
      messages = [message("hint")];
      front.render({ messages });
      expect(status.element.classList).not.toContain("linter-status-hidden");
      expect(visibleSeverities()).toEqual(["hint"]);
      expect(status.stateIcon.hidden).toBe(true);

      messages = [];
      front.render({ messages });
      expect(status.element.classList).toContain("linter-status-hidden");
    });

    it("keeps disabled file linting visible but does not disable an empty project", () => {
      lintingDisabled = true;
      status.update();
      expect(status.element.classList).not.toContain("linter-status-hidden");
      expect(status.stateIcon.classList).toContain("icon-circle-slash");

      front.setViewMode("project");
      expect(status.element.classList).toContain("linter-status-hidden");
      expect(status.element.classList).not.toContain("linting-disabled");
    });
  });
});
