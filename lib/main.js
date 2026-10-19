const { CompositeDisposable, Disposable } = require("lumine");
const { Front } = require("./front");
const { StatusPanel } = require("./status");

const PANEL_URI = "lumine://diagnostics";

let subscriptions = null;
let front = null;
/**
 * The panel, built the first time something asks for it. A package whose panel
 * is never opened pays for the status model and nothing else, and a closed tab
 * drops the item rather than leaving a destroyed one behind.
 * @returns {Object} The panel
 */
function getPanel() {
  if (!front.panel) {
    require("@lumine-code/etch").setScheduler(lumine.views);
    const { Diagnostics } = require("./diagnostics");
    const panel = new Diagnostics(front);
    panel.onDidDestroy(() => {
      if (front.panel === panel) {
        front.panel = null;
      }
    });
    front.panel = panel;
    // The hub may have selected an editor before this lazy panel existed.
    // Subscribe immediately, including when a closed panel is created again.
    panel.setEditor(front.editor);
  }
  return front.panel;
}

/**
 * Builds the front end before anything can ask for the panel.
 *
 * The workspace deserializes its docks during window startup, which is before
 * initial packages activate — and a deserializer deliberately does not trigger
 * activation then, because the workspace element is not in the DOM yet. So a
 * saved panel tab reaches `deserializePanel` with `activate()` still to come.
 * `initialize` is the one hook the editor guarantees ahead of both deserializers
 * and view providers, so the state they need is built here.
 */
function initialize() {
  front ??= new Front();
}

function activate() {
  // Kept rather than replaced: a panel restored during startup deserialization
  // is already talking to this one.
  front ??= new Front();
  subscriptions = new CompositeDisposable(
    lumine.commands.add("lumine-workspace", {
      "diagnostics:toggle": () => getPanel().toggle(),
      "diagnostics:toggle-focus": () => getPanel().toggleFocus(),
      "diagnostics:file-mode": {
        description: "Show only the messages for the file now open.",
        didDispatch: () => front.setViewMode("file"),
      },
      "diagnostics:project-mode": {
        description: "Show the messages for every file in the project.",
        didDispatch: () => front.setViewMode("project"),
      },
      "diagnostics:next": {
        description: "Move to the next diagnostic in the active document.",
        isAvailable: () => !!front?.hub && front.getCurrentMessages().length > 0,
        didDispatch: () => front.nextMessage(),
      },
      "diagnostics:previous": {
        description: "Move to the previous diagnostic in the active document.",
        isAvailable: () => !!front?.hub && front.getCurrentMessages().length > 0,
        didDispatch: () => front.previousMessage(),
      },
      "diagnostics:clear": {
        description: "Clear every diagnostic reported so far.",
        isAvailable: () => !!front?.hub && front.messages.length > 0,
        didDispatch: () => front.clearMessages(),
      },
    }),
    lumine.contextMenu.add({
      ".diagnostics-status": {
        commandTarget: "focus",
        items: [
          { type: "separator" },
          { label: "Toggle Diagnostics", command: "diagnostics:toggle" },
          { label: "Toggle Diagnostics Focus", command: "diagnostics:toggle-focus" },
          { type: "separator" },
          ...[
            ["Next Diagnostic", "diagnostics:next"],
            ["Previous Diagnostic", "diagnostics:previous"],
          ].map(([label, command]) => ({
            label,
            command,
            created() {
              this.enabled = !!front?.hub && front.messages.length > 0;
            },
          })),
          { type: "separator" },
          ...[
            ["Show Active File Diagnostics", "file", "diagnostics:file-mode"],
            ["Show Project Diagnostics", "project", "diagnostics:project-mode"],
          ].map(([label, mode, command]) => ({
            label,
            command,
            type: "radio",
            created() {
              this.checked = front?.viewMode === mode;
            },
          })),
          { type: "separator" },
          {
            label: "Clear All Diagnostics",
            command: "diagnostics:clear",
            created() {
              this.enabled = !!front?.hub && front.messages.length > 0;
            },
          },
          { type: "separator" },
        ],
      },
    }),
    lumine.workspace.addOpener((uri) => (uri === PANEL_URI ? getPanel() : undefined)),
    new Disposable(() => {
      const panel = front.panel;
      if (!panel) return;
      const pane = lumine.workspace.paneForItem(panel);
      if (pane) {
        pane.destroyItem(panel);
      } else {
        panel.destroy();
      }
    }),
  );
}

function deactivate() {
  subscriptions?.dispose();
  subscriptions = null;
  // A startup deserializer may have built the panel before the activation
  // disposable responsible for closing it was registered.
  const destruction = front?.panel?.destroy();
  // The status bar keeps its tiles in an ordered collection and inserts later
  // ones relative to them, so a detached item left behind breaks the next
  // insertion.
  front?.status?.destroy();
  front?.dispose();
  front = null;
  return destruction;
}

/**
 * Restores the panel after a window reload. The workspace records the item by
 * its deserializer name; the opener above answers for the URI.
 * @returns {Object} The panel
 */
function deserializePanel() {
  return getPanel();
}

/**
 * The front end the linter hub renders through.
 * @returns {Object} A `linter.ui` provider
 */
function provideLinterUI() {
  return {
    name: "diagnostics",
    attach: (hub) => front.attach(hub),
    render: (difference) => front.render(difference),
    didChangeActiveItem: () => front.setEditor(),
    didChangeLintingState: () => front.update(),
    async showProjectView() {
      front.setViewMode("project");
      const panel = getPanel();
      await lumine.workspace.open(panel, { searchAllPanes: true, activatePane: false });
      if (panel.destroyed) return;
      lumine.workspace.getBottomDock().show();
      return panel.update();
    },
    dispose: () => front.detach(),
  };
}

/**
 * Consumes the status bar service.
 * @param {Object} statusBar
 */
function consumeStatusBar(service) {
  return service.observeWindows((scopedStatusBar, context) =>
    consumeWindowStatusBar.call(this, scopedStatusBar, context),
  );
}

function consumeWindowStatusBar(statusBar, _context) {
  const status = new StatusPanel(front, statusBar);
  front.status = status;
  return new Disposable(() => {
    status.destroy();
    if (front?.status === status) front.status = null;
  });
}

module.exports = {
  provideBackgroundTips() {
    return {
      packageName: "diagnostics",
      tips: [
        "You can read every lint message in the project in one sortable panel with {{ 'diagnostics:toggle-focus' | keystroke }}",
      ],
    };
  },

  initialize,
  activate,
  deactivate,
  deserializePanel,
  provideLinterUI,
  consumeStatusBar,
  PANEL_URI,
};
