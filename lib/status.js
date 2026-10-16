class StatusPanel {
  constructor(pkg, statusBar = null) {
    this.pkg = pkg;
    this.statusBar = statusBar;
    this.statusTile = null;
    this.editor = null;
    this.statusMode = true;
    this.counters = [];
    this.messageCount = 0;
    this.lintingDisabled = false;
    this.destroyed = false;

    this.element = document.createElement("status-bar-tile");
    this.element.classList.add("linter-status");
    this.element.setAttribute("data-context-menu-boundary", "");
    this.projectIcon = document.createElement("span");
    this.projectIcon.classList.add("linter-status-project", "icon", "icon-file-directory");
    this.projectIcon.setAttribute("aria-hidden", "true");
    this.element.appendChild(this.projectIcon);
    this.stateIcon = document.createElement("span");
    this.stateIcon.classList.add("linter-status-state", "icon", "icon-checklist");
    this.stateIcon.setAttribute("aria-hidden", "true");
    this.element.appendChild(this.stateIcon);

    this.element.onmouseup = (e) => this.onmouseup(e);

    this.configDisposable = lumine.config.observe("linter-panel.statusMode", (value) => {
      this.statusMode = value;
      this.update();
    });

    this.tooltipDisposable = lumine.tooltips.add(this.element, {
      html: false,
      keyBindingCommand: "linter-panel:toggle",
      keyBindingTarget: this.element.closest("lumine-workspace") ?? lumine.workspace.getElement(),
      title: () => this.getTooltipTitle(),
    });

    this.addToStatusBar();
    this.update();
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.element.onmouseup = null;
    this.removeFromStatusBar();
    this.configDisposable.dispose();
    this.tooltipDisposable.dispose();
    this.element.remove();
  }

  setEditor(editor) {
    if (this.destroyed) return;
    this.editor = editor;
    this.update();
  }

  addToStatusBar() {
    if (!this.statusBar || this.statusTile) return;
    this.statusTile = this.statusBar.addLeftTile({ item: this, priority: 210 });
  }

  removeFromStatusBar() {
    const tile = this.statusTile;
    this.statusTile = null;
    tile?.destroy();
  }

  getTooltipTitle() {
    const action = "Click to toggle the panel.";
    if (!this.pkg.hub) return `Diagnostics unavailable. ${action}`;
    const scope = this.pkg.viewMode === "project" ? "Project" : "File";
    const state = this.lintingDisabled
      ? "linting disabled for this file"
      : this.messageCount === 0
        ? "no messages"
        : `${this.messageCount} ${this.messageCount === 1 ? "message" : "messages"}`;
    return `${scope} diagnostics: ${state}. ${action}`;
  }

  /**
   * One counter per severity, built from the hub's vocabulary when available,
   * or from Front's baseline before the hub connects. The tile stays attached
   * even before the first editor, so the status bar has a stable control from
   * the first paint.
   */
  buildCounters() {
    const records = this.pkg.severities.records;
    if (this.counterRecords === records) {
      return;
    }
    this.counterRecords = records;
    for (const { counter } of this.counters) {
      counter.remove();
    }
    this.counters = records.map((severity) => {
      const counter = document.createElement("span");
      counter.classList.add("linter-status-counter");
      const icon = document.createElement("span");
      icon.classList.add("icon", severity.icon);
      icon.setAttribute("aria-hidden", "true");
      counter.appendChild(icon);
      const label = document.createElement("span");
      counter.appendChild(label);
      this.element.appendChild(counter);
      return { severity, counter, label };
    });
  }

  update() {
    this.buildCounters();
    const counts = this.pkg.getMessageCounts();
    // Disabling one file does not disable the rest of the project's diagnostics.
    const lintingDisabled = this.pkg.viewMode !== "project" && this.pkg.isLintingDisabled();
    this.lintingDisabled = lintingDisabled;

    let messageCount = 0;
    for (const { severity, counter, label } of this.counters) {
      const count = counts[severity.name] ?? 0;
      counter.classList.toggle(severity.textClass, count > 0 && !lintingDisabled);
      label.textContent = count;
      counter.classList.toggle("linter-status-counter-hidden", count === 0);
      messageCount += count;
    }
    this.messageCount = messageCount;

    // An empty result does not prove that a provider has checked the file.
    this.stateIcon.classList.toggle("icon-checklist", !lintingDisabled);
    this.stateIcon.classList.toggle("icon-circle-slash", lintingDisabled);
    this.stateIcon.hidden = messageCount > 0 && !lintingDisabled;
    this.projectIcon.hidden = this.pkg.viewMode !== "project";

    this.element.classList.toggle("linting-disabled", lintingDisabled);
    this.element.classList.toggle("project-mode", this.pkg.viewMode === "project");
    this.element.classList.toggle(
      "linter-status-hidden",
      !this.statusMode && messageCount === 0 && !lintingDisabled,
    );
    this.element.setAttribute("aria-label", this.getTooltipTitle());
  }

  // The hub owns navigating between messages and clearing them, so those two
  // go out as commands rather than through the handle: they are the same
  // actions the menu and the keymap dispatch.
  dispatch(command) {
    return lumine.commands.dispatch(this.element, command);
  }

  onmouseup(e) {
    if (this.destroyed) return;
    if (e.button === 0 || e.which === 1) {
      if (process.platform === "darwin" && e.ctrlKey) return;
      if (e.metaKey || e.ctrlKey) this.dispatch("linter:next");
      else if (e.shiftKey) this.dispatch("linter:previous");
      else this.dispatch("linter-panel:toggle");
    } else if (e.button === 1 || e.which === 2) {
      this.dispatch(
        this.pkg.viewMode === "project" ? "linter-panel:file-mode" : "linter-panel:project-mode",
      );
    }
  }
}

module.exports = { StatusPanel };
