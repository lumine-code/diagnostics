/** @jsx etch.dom */
const etch = require("@lumine-code/etch");
const path = require("path");
const { CompositeDisposable, Emitter } = require("lumine");
const {
  renderExcerpt,
  messageSubject,
  editorForBuffer,
  relatedFileTarget,
  supplementaryDescription,
} = require("./helpers");

const PANEL_URI = "lumine://diagnostics";
const EXTERNAL_URL_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);
const INLINE_DESCRIPTION_LIMIT = 48;

const externalUrl = (value) => {
  try {
    const url = new URL(value);
    return EXTERNAL_URL_PROTOCOLS.has(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
};

class Diagnostics {
  constructor(pkg) {
    this.pkg = pkg;
    this.editor = null;
    this.cwatch = null;
    this.emitter = new Emitter();
    this.sortMethod = lumine.config.get("diagnostics.defaultSortMethod") || "severity";
    this.sortDirection = "asc";
    // Severities the user has filtered out. Empty means "show everything", so a
    // severity the panel has never heard of stays visible rather than being
    // silently swallowed.
    this.hiddenSeverities = new Set();
    // Cache sorted messages to avoid re-sorting on every render
    this._sortedMessagesCache = null;
    this._lastMessages = null;
    this._lastSortMethod = null;
    this._lastSortDirection = null;
    // The severity filter is a Set that is mutated in place, so the visible-row
    // cache watches this counter rather than the Set itself.
    this._filterGeneration = 0;
    this._visibleCache = null;
    // Only the rows the viewport can show are rendered; the rest of the scroll
    // height is two spacer rows. Everything outside `render` addresses rows by
    // their index in the visible list, never by their position in the DOM.
    this._rowHeight = 0;
    this._window = { start: 0, end: 0 };
    this._onScroll = this._onScroll.bind(this);
    // The current row in the visible list, even outside the rendered viewport.
    this._currentRowIndex = -1;
    // Track right-clicked row for context menu
    this._contextRow = null;
    // The keyboard cursor follows a message's key across replacement objects
    // and re-sorts, and a message that disappears takes the cursor with it.
    // Rendered as a class from state — never patched into the DOM
    // behind etch's back.
    this._focusedMessage = null;
    this._detailsMessage = null;
    this._listViewport = null;
    // Header navigation keeps its place after revealing a message moves focus
    // to the editor, including when several diagnostics share one position.
    this._navigationMessage = null;
    this._navigating = false;
    this.destroyed = false;
    this._headerTooltips = new Map();
    // Bind row click handler once for event delegation
    this._onRowClick = this._onRowClick.bind(this);
    this._onRowMiddleClick = this._onRowMiddleClick.bind(this);
    etch.initialize(this);
    this._syncHeaderTooltips();

    // Prevent browser auto-scroll on middle-click
    this.element.addEventListener("mousedown", (e) => {
      if (e.button === 1) e.preventDefault();
    });

    // Handle middle-click to delete individual messages
    this.element.addEventListener("mouseup", (e) => {
      if (e.button === 1) this._onRowMiddleClick(e);
    });

    // Leaving the panel ends the keyboard journey; no cursor lies in wait
    // for the next visit.
    this.element.addEventListener("focusout", (e) => {
      if (!this.element.contains(e.relatedTarget) && this._focusedMessage) {
        this._focusedMessage = null;
        this.update();
      }
    });

    // Context menu: track which row was right-clicked
    this.element.addEventListener("contextmenu", (e) => {
      const row = e.target.closest(".diagnostics-row");
      this._contextRow = row;
    });

    // Scrolling changes which rows exist. Passive, because the handler never
    // calls preventDefault and a non-passive wheel path on a list this long is
    // exactly what stutters.
    const scrollContainer = this._scrollContainer();
    if (scrollContainer) {
      scrollContainer.addEventListener("scroll", this._onScroll, { passive: true });

      // Theme density can resize a row without resizing the viewport. Watch a
      // rendered row too, and rebuild the spacers whenever its height changes.
      this._resizeObserver = new ResizeObserver(() => {
        if (this._detailsMessage || !scrollContainer.clientHeight) return;
        const previousHeight = this._rowHeight;
        this._rowHeight = 0;
        const rowHeight = this._measureRowHeight();
        if (rowHeight && rowHeight !== previousHeight) {
          this.update();
        } else {
          this._onScroll();
        }
      });
      this._resizeObserver.observe(scrollContainer);
      this._observeRow();
    }

    // Register context menu and keyboard navigation commands
    this._disposables = new CompositeDisposable();
    // The panel renders nothing while it is out of sight, so it has to be told
    // when it comes back. Neither transition resizes anything the observer
    // above is watching: a pane shows its active item by lifting a `display`,
    // and a dock opens by growing a mask over content that never changed size.
    this._disposables.add(
      lumine.workspace.onDidChangeActivePaneItem(() => this.update()),
      ...lumine.workspace
        .getPaneContainers()
        .filter((container) => typeof container.onDidChangeVisible === "function")
        .map((container) => container.onDidChangeVisible(() => this.update())),
    );
    this._disposables.add(
      lumine.commands.add(this.element, {
        "diagnostics:open-details": {
          description: "Inspect the clicked diagnostic.",
          isAvailable: ({ target }) =>
            !this._detailsMessage && Boolean(this._messageForRow(target)),
          didDispatch: ({ target }) => this._openMessageDetails(this._messageForRow(target)),
        },
        "diagnostics:copy-description": {
          description: "Copy the selected message's text to the clipboard.",
          didDispatch: () => this._copyDescription(),
        },
        "diagnostics:copy-details": {
          description: "Copy the selected message with its file and line.",
          didDispatch: () => this._copyDetails(),
        },
        "core:move-up": (e) => {
          e.stopPropagation();
          if (!this._detailsMessage) this._moveFocusUp();
        },
        "core:move-down": (e) => {
          e.stopPropagation();
          if (!this._detailsMessage) this._moveFocusDown();
        },
        "core:confirm": (e) => {
          if (e.target.closest?.("button")) return;
          e.stopPropagation();
          if (!this._detailsMessage) return this._confirmFocused();
        },
        "core:cancel": (e) => {
          if (e.target.closest?.(".data-table-sort")) return;
          e.stopPropagation();
          return this._detailsMessage ? this._closeMessageDetails() : this._cancelFocus();
        },
      }),
    );
  }

  /**
   * The messages to show. Which set that is — the active item's or the
   * project's — is the front end's business, not the panel's.
   */
  _getMessages() {
    return this.pkg.getMessages();
  }

  /**
   * The view mode changed under us. The front end owns it, because the
   * status-bar tile renders it too.
   */
  viewModeChanged() {
    this._navigationMessage = null;
    this._detailsMessage = null;
    // Clear .current highlight BEFORE state reset (etch won't touch it)
    const currentRow = this.element?.querySelector(".diagnostics-row.current");
    if (currentRow) {
      currentRow.classList.remove("current");
    }
    this._currentRowIndex = -1;
    this._sortedMessagesCache = null;
    this._lastMessages = null;
    this.observe();
  }

  /**
   * Handle row clicks using event delegation for better performance.
   * Uses data attributes to find message position instead of closures.
   */
  _onRowClick(event) {
    if (event.button !== 0) return;
    const location = event.target.closest(".diagnostics-log-ref, .diagnostics-related-location");
    if (location) {
      event.stopPropagation();
      const file = location.dataset.file;
      const line = parseInt(location.dataset.line, 10);
      const column = parseInt(location.dataset.column, 10) || 0;
      if (file) {
        lumine.workspace.open(file, {
          initialLine: line,
          initialColumn: column,
          pending: true,
        });
      }
      return;
    }

    // "more info" opens the provider's documentation rather than the message
    const moreInfo = event.target.closest(".diagnostics-more-info");
    if (moreInfo) {
      event.stopPropagation();
      if (moreInfo.dataset.url) {
        void lumine.shell.openExternal(moreInfo.dataset.url).catch((error) => {
          lumine.notifications.addWarning("Unable to open the linter documentation.", {
            detail: error.message,
            dismissable: true,
          });
        });
      }
      return;
    }

    if (this._detailsMessage) return;
    const message = this._messageForRow(event.target);
    if (!message) return;

    if (event.altKey) {
      event.preventDefault();
      event.stopPropagation();
      void this._openMessageDetails(message);
      return;
    }

    this._navigationMessage = null;
    if (this.pkg.viewMode === "project") {
      this._openMessage(message);
    } else {
      this.pkg.revealMessage(message);
    }
  }

  _onRowMiddleClick(event) {
    if (this._detailsMessage || event.target.closest(".diagnostics-related-location")) return;
    const message = this._messageForRow(event.target);
    if (message) this.pkg.deleteMessage(message);
  }

  setEditor(editor) {
    if (editor !== this.editor && !this._navigating) this._navigationMessage = null;
    this.editor = editor;
    // Clear .current highlight BEFORE re-render (etch won't touch it if virtual DOM unchanged)
    const currentRow = this.element?.querySelector(".diagnostics-row.current");
    if (currentRow) {
      currentRow.classList.remove("current");
    }
    this._currentRowIndex = -1;
    // Invalidate cache when editor changes (only matters in file mode)
    if (this.pkg.viewMode === "file") {
      this._sortedMessagesCache = null;
      this._lastMessages = null;
    }
    this.observe();
  }

  /**
   * Updates only the current row highlight using CSS classes.
   * Avoids full etch re-render for cursor position changes.
   */
  _updateCurrentRowHighlight() {
    if (!this.editor || !this.element) return;
    // Runs on every cursor move as well as after every render. There is no row to mark while
    // the panel is off screen, and the next render takes the highlight anyway.
    if (!this._isOnScreen()) return;

    const curpos = this.editor.getCursorBufferPosition();
    // In project mode the list spans every file, and only the active editor's
    // own messages can sit under its cursor. Which those are is the hub's
    // answer, not a path comparison of the panel's own devising.
    let newRowIndex = -1;
    const candidates = this.pkg.getMessagesAtPosition?.(this.editor, curpos) ?? null;
    if (candidates !== null) {
      this._visibleMessages();
      for (const message of candidates) {
        const index = this._visibleCache.messageIndices.get(message);
        if (index !== undefined && message === this._navigationMessage) {
          newRowIndex = index;
          break;
        }
        if (index !== undefined && (newRowIndex < 0 || index < newRowIndex)) newRowIndex = index;
      }
    } else {
      // Older hubs can still provide the panel's original message-only handle.
      const visible = this._visibleMessages();
      const current =
        this.pkg.viewMode === "project" ? new Set(this.pkg.getCurrentMessages()) : null;
      for (let index = 0; index < visible.length; index++) {
        const message = visible[index];
        if (current && !current.has(message)) continue;
        const range = message.location.displayRange || message.location.position;
        if (range.containsPoint(curpos)) {
          if (newRowIndex < 0 || message === this._navigationMessage) newRowIndex = index;
          if (!this._navigationMessage || message === this._navigationMessage) break;
        }
      }
    }

    // A redraw may have replaced the row even when the current message is the
    // same. Restore its highlight, but only a changed row should reveal itself:
    // a scroll redraw must not pull the user back to the editor's cursor.
    const currentRowChanged = newRowIndex !== this._currentRowIndex;

    const tbody = this.element.querySelector("tbody");
    if (!tbody) return;

    // Rows are addressed by their visible index, not by their place among the
    // tbody's children: a windowed render puts a spacer first and leaves most
    // of the list out of the DOM entirely.
    const rowAt = (visibleIndex) =>
      tbody.querySelector(`.diagnostics-row[data-visible-index="${visibleIndex}"]`);

    // Remove current class from old row
    if (this._currentRowIndex >= 0) {
      const oldRow = rowAt(this._currentRowIndex);
      if (oldRow) {
        oldRow.classList.remove("current");
      }
    }

    // Add current class to new row
    if (newRowIndex >= 0) {
      const newRow = rowAt(newRowIndex);
      if (newRow) {
        newRow.classList.add("current");
      }
    }

    this._currentRowIndex = newRowIndex;
    if (currentRowChanged) this.scrollToCurrent();
  }

  /**
   * Returns sorted messages, using cache if inputs haven't changed.
   * Avoids re-sorting on every cursor move (which triggers render).
   */
  _getSortedMessages(messages) {
    // Check if we can use cached result
    if (
      this._sortedMessagesCache &&
      this._lastMessages === messages &&
      this._lastSortMethod === this.sortMethod &&
      this._lastSortDirection === this.sortDirection &&
      this._lastViewMode === this.pkg.viewMode
    ) {
      return this._sortedMessagesCache;
    }

    // Need to re-sort
    let sortedMessages;
    if (this.sortMethod === "severity") {
      sortedMessages = [...messages].sort((a, b) => {
        const severityDiff = this.pkg.severities.compare(a.severity, b.severity);
        if (severityDiff !== 0) {
          return this.sortDirection === "asc" ? severityDiff : -severityDiff;
        }
        const positionDiff = compareMessagePosition(a, b, false);
        return this.sortDirection === "asc" ? positionDiff : -positionDiff;
      });
    } else if (this.sortMethod === "provider") {
      sortedMessages = [...messages].sort((a, b) => {
        // Use < > comparison instead of localeCompare for better performance
        if (a.linterName < b.linterName) return this.sortDirection === "asc" ? -1 : 1;
        if (a.linterName > b.linterName) return this.sortDirection === "asc" ? 1 : -1;
        const positionDiff = compareMessagePosition(a, b, false);
        return this.sortDirection === "asc" ? positionDiff : -positionDiff;
      });
    } else {
      // "position" sort: in project mode, sort by file path then position
      // in file mode, sort by position only
      const byFile = this.pkg.viewMode === "project";
      sortedMessages = [...messages].sort((a, b) => {
        const val = compareMessagePosition(a, b, byFile);
        return this.sortDirection === "asc" ? val : -val;
      });
    }

    // Update cache
    this._sortedMessagesCache = sortedMessages;
    this._lastMessages = messages;
    this._lastSortMethod = this.sortMethod;
    this._lastSortDirection = this.sortDirection;
    this._lastViewMode = this.pkg.viewMode;

    return sortedMessages;
  }

  // Copy the provider's full text, including descriptions resolved on demand.
  _copyDescription() {
    const message = this._contextMessage();
    if (!message) return;
    this.pkg.resolveDescription(message).then((description) => {
      lumine.clipboard.write([message.excerpt, description].filter(Boolean).join("\n\n"));
    });
  }

  _contextMessage() {
    return this._messageForRow(this._contextRow);
  }

  _messageForRow(target) {
    const row = target?.closest?.(".diagnostics-row");
    if (!row || row.parentElement !== this.refs.scrollport) return null;
    return this._getSortedMessages(this._getMessages())[Number(row.dataset.index)] ?? null;
  }

  _copyDetails() {
    const message = this._contextMessage();
    if (!message) return;
    // The linter's own bookkeeping is not part of what a provider reported.
    const internal = new Set(["key", "version", "displayRange", "normalizedFile"]);
    lumine.clipboard.write(JSON.stringify(message, (k, v) => (internal.has(k) ? undefined : v), 2));
  }

  /**
   * Abbreviates a file path relative to the project root.
   */
  _abbreviatePath(filePath) {
    if (!filePath) return "";
    const projectPaths = lumine.project.getPaths();
    const multiProject = projectPaths.length > 1;
    for (const projectPath of projectPaths) {
      if (filePath.startsWith(projectPath)) {
        const relative = filePath.substring(projectPath.length + 1).replace(/\\/g, "/");
        return multiProject ? path.basename(projectPath) + "/" + relative : relative;
      }
    }
    return path.basename(filePath);
  }

  async _openMessageDetails(message) {
    if (!message || this.destroyed || this._detailsMessage) return;
    const list = this._scrollContainer();
    this._listViewport = list && { clientHeight: list.clientHeight, scrollTop: list.scrollTop };
    this._detailsMessage = message;
    const rendered = this.update();
    if (this.pkg.hasLazyDescription(message)) {
      void this.pkg.resolveDescription(message).then(() => {
        if (!this.destroyed && this._detailsMessage === message) void this.update();
      });
    }
    await rendered;
    if (!this.destroyed && this._detailsMessage === message) {
      this.refs.detailsBack?.focus({ preventScroll: true });
    }
  }

  async _closeMessageDetails() {
    this._detailsMessage = null;
    await this.update();
    if (!this.destroyed && !this._detailsMessage) {
      this.element.focus({ preventScroll: true });
    }
  }

  _renderRelatedLocation(item, message) {
    const target = relatedFileTarget(item);
    const { file, row, column, position, label } = target;
    const pathApi = /^[A-Za-z]:[\\/]|^\\\\/.test(file) ? path.win32 : path;
    const normalizePath = this.pkg.hub?.normalizePath;
    const sameFile = normalizePath
      ? normalizePath(file) === normalizePath(message.location.file)
      : file === message.location.file;
    const [root, relative] = sameFile ? [] : lumine.project.relativizePath(file);
    const name = root ? relative : pathApi.basename(file);
    return (
      <button
        type="button"
        class="diagnostics-related-location native-key-bindings"
        dataset={{ file, line: row, column }}
        title={label}
        attributes={{ "aria-label": `${item.message} ${label}` }}
      >
        {`${name}:${position}`}
      </button>
    );
  }

  _renderMessageDetails(message) {
    const description = supplementaryDescription(message, this.pkg.getDescription(message));
    const related = message.relatedInformation ?? [];
    const hasCode = message.code != null && message.code !== "";
    const severity = this.pkg.severities.get(message.severity);
    return (
      <section
        class="diagnostics-message-details"
        attributes={{ "aria-label": "Diagnostic details" }}
      >
        <header class="diagnostics-message-details-header">
          <button
            type="button"
            class="btn diagnostics-back-to-list native-key-bindings icon icon-arrow-left"
            ref="detailsBack"
            title="Back to diagnostics"
            attributes={{ "aria-label": "Back to diagnostics" }}
            on={{ click: () => this._closeMessageDetails() }}
          >
            Back
          </button>
          <span
            class={severity ? this.pkg.severities.classFor(severity.name) : "diagnostics-severity"}
          >
            {severity?.label ?? String(message.severity)}
          </span>
          <span class="diagnostics-message-details-title" title={message.source}>
            {message.linterName || message.source}
          </span>
          {hasCode ? <code class="diagnostics-code">{String(message.code)}</code> : null}
        </header>
        <div
          class="diagnostics-message-details-body native-key-bindings"
          tabIndex="0"
          attributes={{ "data-scrollbar": "auto" }}
          on={{ click: this._onRowClick }}
        >
          <div
            class="diagnostics-message-details-excerpt"
            innerHTML={renderExcerpt(message.excerpt)}
          />
          {description ? (
            <div class="diagnostics-message-details-description">{description}</div>
          ) : null}
          {this.pkg.hasLazyDescription(message) ? (
            <div role="status">Loading description…</div>
          ) : null}
          {related.length > 0 ? (
            <ul class="diagnostics-message-details-related">
              {related.map((item) => (
                <li>
                  <div>{item.message}</div>
                  {item.location?.file ? (
                    this._renderRelatedLocation(item, message)
                  ) : (
                    <div>{item.uri}</div>
                  )}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      </section>
    );
  }

  destroy() {
    this.destroyed = true;
    for (const tooltip of this._headerTooltips.values()) tooltip.dispose();
    this._headerTooltips.clear();
    if (this.cwatch) {
      this.cwatch.dispose();
      this.cwatch = null;
    }
    if (this._disposables) {
      this._disposables.dispose();
    }
    if (this._resizeObserver) {
      this._resizeObserver.disconnect();
      this._resizeObserver = null;
    }
    this._scrollContainer()?.removeEventListener("scroll", this._onScroll);
    const destroyed = etch.destroy(this);
    // A pane only drops an item it is told about, and the package only forgets
    // a panel that says it has gone.
    this.emitter.emit("did-destroy");
    this.emitter.dispose();
    return destroyed;
  }

  onDidDestroy(callback) {
    return this.emitter.on("did-destroy", callback);
  }

  update() {
    // Etch does not own .current. Clear the DOM class before patching, but keep
    // its logical index so restoring the highlight does not also reset scroll.
    const currentRow = this.element?.querySelector(".diagnostics-row.current");
    if (currentRow) currentRow.classList.remove("current");
    return etch.update(this).then(() => {
      if (this.destroyed || this._detailsMessage) return;
      const list = this._scrollContainer();
      if (this._listViewport && list?.clientHeight) {
        list.scrollTop = this._listViewport.scrollTop;
        this._listViewport = null;
        return this._onScroll();
      }
      // The first render had no row to measure and put up a bootstrap window.
      // Now that one exists, take the real window rather than waiting for a
      // scroll that may never come. `_rowHeight` is set from here on, so this
      // corrects itself once and cannot loop.
      if (!this._rowHeight && this._measureRowHeight()) {
        return this._onScroll();
      }
    });
  }

  readAfterUpdate() {
    this._syncHeaderTooltips();
    if (!this._detailsMessage) this._updateCurrentRowHighlight();
    this._observeRow();
  }

  _syncHeaderTooltips() {
    if (this.destroyed || !this.element) return;
    const controls = new Set(this.element.querySelectorAll(".diagnostics-toggles [data-tooltip]"));
    for (const [element, tooltip] of this._headerTooltips) {
      if (controls.has(element)) continue;
      tooltip.dispose();
      this._headerTooltips.delete(element);
    }
    for (const element of controls) {
      if (this._headerTooltips.has(element)) continue;
      this._headerTooltips.set(
        element,
        lumine.tooltips.add(element, { html: false, title: () => element.dataset.tooltip }),
      );
    }
  }

  setSortMethod(method) {
    if (this.sortMethod === method) {
      this.sortDirection = this.sortDirection === "asc" ? "desc" : "asc";
    } else {
      this.sortMethod = method;
      this.sortDirection = "asc";
    }
    this.update();
  }

  isSeverityVisible(severity) {
    return !this.hiddenSeverities.has(severity);
  }

  toggleVisibility(severity) {
    if (this.hiddenSeverities.has(severity)) {
      this.hiddenSeverities.delete(severity);
    } else {
      this.hiddenSeverities.add(severity);
    }
    this._filterGeneration++;
    this.update();
  }

  render() {
    const isProject = this.pkg.viewMode === "project";
    // Keep sorting lazy while the dock is hidden, including for button state.
    const onScreen = this._isOnScreen();
    const visible = onScreen ? this._visibleMessages() : [];
    const details = this._detailsMessage;
    const navigationDisabled = visible.length === 0 || this._navigating;
    const empty = onScreen && visible.length === 0;
    const emptyMessage =
      empty && this._getMessages().length
        ? "No diagnostics match the selected filters"
        : isProject
          ? "No diagnostics in the project"
          : "No diagnostics in the active file";

    const thirdLabel = isProject ? "File" : "Position";
    const sortState = (method) =>
      this.sortMethod === method
        ? this.sortDirection === "asc"
          ? "ascending"
          : "descending"
        : "none";

    const head = (
      <tr class="diagnostics-header">
        <th attributes={{ scope: "col", "aria-sort": sortState("severity") }}>
          <button
            type="button"
            class="data-table-sort native-key-bindings"
            on={{ click: () => this.setSortMethod("severity") }}
          >
            <span class="data-table-sort-label">Severity</span>
          </button>
        </th>
        <th attributes={{ scope: "col", "aria-sort": sortState("provider") }}>
          <button
            type="button"
            class="data-table-sort native-key-bindings"
            on={{ click: () => this.setSortMethod("provider") }}
          >
            <span class="data-table-sort-label">Provider</span>
          </button>
        </th>
        <th attributes={{ scope: "col", "aria-sort": sortState("position") }}>
          <button
            type="button"
            class="data-table-sort native-key-bindings"
            on={{ click: () => this.setSortMethod("position") }}
          >
            <span class="data-table-sort-label">{thirdLabel}</span>
          </button>
        </th>
        <th attributes={{ scope: "col" }}>
          <span class="diagnostics-header-title">Description</span>
          <span class="diagnostics-toggles">
            <span
              class={
                this.pkg.viewMode === "file"
                  ? "diagnostics-view-tab active"
                  : "diagnostics-view-tab"
              }
              dataset={{ tooltip: "Show diagnostics for the active file" }}
              on={{ click: () => this.pkg.setViewMode("file") }}
            >
              File
            </span>
            <span
              class={
                this.pkg.viewMode === "project"
                  ? "diagnostics-view-tab active"
                  : "diagnostics-view-tab"
              }
              dataset={{ tooltip: "Show diagnostics for the whole project" }}
              on={{ click: () => this.pkg.setViewMode("project") }}
            >
              Project
            </span>
            <button
              type="button"
              class="diagnostics-navigation data-table-header-action native-key-bindings icon icon-arrow-left"
              dataset={{ tooltip: "Previous Diagnostic" }}
              attributes={{ "aria-label": "Previous Diagnostic" }}
              disabled={navigationDisabled}
              on={{ click: () => this._navigateMessage(-1) }}
            />
            <button
              type="button"
              class="diagnostics-navigation data-table-header-action native-key-bindings icon icon-arrow-right"
              dataset={{ tooltip: "Next Diagnostic" }}
              attributes={{ "aria-label": "Next Diagnostic" }}
              disabled={navigationDisabled}
              on={{ click: () => this._navigateMessage(1) }}
            />
            <button
              type="button"
              class="diagnostics-clear data-table-header-action native-key-bindings icon icon-x"
              dataset={{ tooltip: "Clear All Diagnostics" }}
              attributes={{ "aria-label": "Clear All Diagnostics" }}
              disabled={!this.pkg.hub || this.pkg.messages.length === 0 || this._navigating}
              on={{ click: () => this._clearMessages() }}
            />
            {this.pkg.severities.records.map((severity) => (
              <label
                class={`input-label ${severity.name}`}
                dataset={{ tooltip: `Toggle ${severity.label} messages` }}
              >
                <input
                  class="input-toggle"
                  type="checkbox"
                  checked={this.isSeverityVisible(severity.name)}
                  attributes={{ "aria-label": `Toggle ${severity.label} messages` }}
                  on={{ change: () => this.toggleVisibility(severity.name) }}
                />
              </label>
            ))}
          </span>
        </th>
      </tr>
    );

    const data = [];
    // Sorting and filtering are only worth their O(n log n) when a row can come
    // of them; an off-screen panel renders an empty tbody.
    const { start, end } = details ? { start: 0, end: 0 } : this._visibleWindow(visible.length);
    this._window = { start, end };

    for (let visibleIndex = start; visibleIndex < end; visibleIndex++) {
      const message = visible[visibleIndex];
      const i = this._sortedIndexFor(visibleIndex);

      // A severity outside the model still gets a row: it is listed with its
      // raw name rather than rendering an empty cell.
      const severity = this.pkg.severities.get(message.severity);
      const scls = severity ? this.pkg.severities.classFor(severity.name) : "diagnostics-severity";
      const stxt = severity ? severity.label : String(message.severity);

      // Build position/file cell content
      const positionContent = [];
      const cell = message.location.cell;
      if (isProject) {
        // Project mode: show abbreviated file path + line:col
        const subject = messageSubject(message);
        const abbrev = this._abbreviatePath(subject);
        positionContent.push(
          <span class="diagnostics-file-path" title={subject}>
            {abbrev}
          </span>,
        );
        positionContent.push(
          <span class="diagnostics-file-line">
            {cell != null ? `[${cell}]:` : ""}
            {message.location.position.start.row + 1}:{message.location.position.start.column + 1}
          </span>,
        );
      } else {
        // File mode: show line:col
        positionContent.push(
          <span>
            {cell != null ? `[${cell}]:` : ""}
            {message.location.position.start.row + 1}:{message.location.position.start.column + 1}
          </span>,
        );
        // Add log reference link if available
        if (message.reference && message.reference.file) {
          const refLine = Array.isArray(message.reference.position)
            ? message.reference.position[0]
            : (message.reference.position?.row ?? 0);
          const refColumn = Array.isArray(message.reference.position)
            ? message.reference.position[1]
            : (message.reference.position?.column ?? 0);
          positionContent.push(
            <a
              class="diagnostics-log-ref"
              dataset={{ file: message.reference.file, line: refLine, column: refColumn }}
              title={`Open log at line ${refLine + 1}`}
            >
              log:{refLine + 1}
            </a>,
          );
        }
      }

      const descriptionContent = [
        <span
          class="diagnostics-excerpt"
          title={message.excerpt}
          innerHTML={renderExcerpt(message.excerpt)}
        />,
      ];
      const hasCode = message.code != null && message.code !== "";
      const related = message.relatedInformation ?? [];
      const origin = related.find((item) => item.location?.file);
      const description = this.pkg.getDescription(message);
      const inlineDescription =
        !hasCode &&
        !message.source &&
        related.length === 0 &&
        description &&
        description.length <= INLINE_DESCRIPTION_LIMIT &&
        !description.includes("\n");
      if (hasCode) {
        descriptionContent.push(<code class="diagnostics-code">{String(message.code)}</code>);
      }
      if (origin) {
        descriptionContent.push(this._renderRelatedLocation(origin, message));
      }
      if (inlineDescription) {
        descriptionContent.push(
          <span class="diagnostics-detail" title={description}>
            {description}
          </span>,
        );
      }
      const moreInfoURL = externalUrl(message.url);
      if (moreInfoURL) {
        descriptionContent.push(
          <a class="diagnostics-more-info" dataset={{ url: moreInfoURL }} title={moreInfoURL}>
            more info
          </a>,
        );
      }

      const item = (
        <tr
          // Preserve painted rows when the window moves. A diagnostic key can
          // repeat; the absolute visible index identifies this row's slot.
          key={`diagnostics-row:${visibleIndex}`}
          class={
            "diagnostics-row data-table-row " +
            (severity ? severity.name : "unknown") +
            (message === this._focusedMessage ? " focused" : "")
          }
          dataset={{ index: i, visibleIndex: visibleIndex }}
        >
          <td class={scls}>{stxt}</td>
          <td class="diagnostics-provider" title={message.linterName}>
            {message.linterName}
          </td>
          <td class="diagnostics-position">{positionContent}</td>
          <td class="diagnostics-description">{descriptionContent}</td>
        </tr>
      );

      data.push(item);
    }

    // The rows that were not rendered still take up their share of the scroll
    // height, so the scrollbar and every scrollTop the panel computes match a
    // list that is all there.
    const rowHeight = this._rowHeight;
    const rows = [];
    if (rowHeight && start > 0) {
      rows.push(
        <tr
          key="diagnostics-spacer-before"
          class="diagnostics-spacer"
          style={`height: ${start * rowHeight}px`}
        />,
      );
    }
    rows.push(...data);
    if (!details && rowHeight && end < visible.length) {
      rows.push(
        <tr
          key="diagnostics-spacer-after"
          class="diagnostics-spacer"
          style={`height: ${(visible.length - end) * rowHeight}px`}
        />,
      );
    }

    return (
      // tabIndex -1, not 0. Every other focusable panel in the fleet uses -1:
      // the panel is reached with alt-l or a click, not by tabbing through the
      // window, and 0 puts it in the document's tab order between the editor
      // and whatever comes next.
      <div
        class={`diagnostics data-table-container${details ? "" : " tab-content-separated"}`}
        tabIndex="-1"
      >
        <table
          class={`diagnostics-table data-table${empty ? " is-empty" : ""}`}
          hidden={Boolean(details)}
        >
          <thead>{head}</thead>
          <tbody
            ref="scrollport"
            attributes={{ "data-scrollbar": "auto" }}
            on={{ click: this._onRowClick }}
          >
            {rows}
          </tbody>
        </table>
        {onScreen && details ? this._renderMessageDetails(details) : null}
        {empty && !details ? (
          <div class="panel-empty-state">
            <background-tips>
              <ul class="centered background-message">
                <li>{emptyMessage}</li>
              </ul>
            </background-tips>
          </div>
        ) : null}
      </div>
    );
  }

  getTitle() {
    return "Diagnostics";
  }

  getURI() {
    return PANEL_URI;
  }

  // What the workspace records so the panel is still there after a reload. The
  // package's `deserializePanel` answers for the name, and the opener it
  // registers answers for the URI.
  serialize() {
    return { deserializer: "Diagnostics", uri: PANEL_URI };
  }

  getIconName() {
    return "alert";
  }

  getDefaultLocation() {
    return "bottom";
  }

  getAllowedLocations() {
    return ["bottom"];
  }

  toggle() {
    const refocus = lumine.workspace.getActivePaneItem() != this;
    let prev = document.activeElement;
    return lumine.workspace.toggle(this).then(() => {
      if (refocus) {
        prev.focus();
      }
      // Restore the rows and their current highlight after showing the panel.
      // Keep the scroll position unless the current row has changed.
      return this.update();
    });
  }

  observe() {
    if (this.cwatch) {
      this.cwatch.dispose();
      this.cwatch = null;
    }
    if (this.editor) {
      // Use CSS-only highlight update instead of full re-render
      // This is much faster as it only updates 2 DOM elements instead of entire table
      const updateHighlight = throttle(() => this._updateCurrentRowHighlight(), 100);
      this.cwatch = this.editor.onDidChangeCursorPosition(() => {
        if (!this._navigating) this._navigationMessage = null;
        updateHighlight();
      });
    }
  }

  scrollToCurrent() {
    this._scrollIndexIntoView(this._currentRowIndex);
  }

  // Brings a row into view by arithmetic rather than by measuring it. The row
  // may well not be in the DOM — that is the case this exists for, since
  // scrolling to a row is how it gets rendered in the first place.
  _scrollIndexIntoView(visibleIndex) {
    if (visibleIndex < 0) return;

    const container = this._scrollContainer();
    const rowHeight = this._rowHeight || this._measureRowHeight();
    if (!container || !rowHeight) return;

    const rowTop = visibleIndex * rowHeight;
    const rowBottom = rowTop + rowHeight;

    if (rowTop < container.scrollTop) {
      container.scrollTop = Math.floor(rowTop);
    } else if (rowBottom > container.scrollTop + container.clientHeight) {
      container.scrollTop = Math.ceil(rowBottom - container.clientHeight);
    }
  }

  // The visible rows, in render order: sorted, severity-filtered.
  _visibleMessages() {
    const sorted = this._getSortedMessages(this._getMessages());
    if (
      this._visibleCache &&
      this._visibleCache.sorted === sorted &&
      this._visibleCache.generation === this._filterGeneration
    ) {
      return this._visibleCache.messages;
    }

    // The row index the click handler reads is an index into `sorted`, and a
    // windowed render cannot recount it, so the mapping is kept alongside — as
    // an array, since it is dense and read by position.
    const messages = [];
    const indices = [];
    const messageIndices = new Map();
    let focusedReplacement = null;
    let navigationReplacement = null;
    for (let i = 0; i < sorted.length; i++) {
      const message = sorted[i];
      if (!this.isSeverityVisible(message.severity)) continue;
      if (!messageIndices.has(message)) messageIndices.set(message, messages.length);
      if (
        !focusedReplacement &&
        this._focusedMessage?.key != null &&
        message.key === this._focusedMessage.key
      ) {
        focusedReplacement = message;
      }
      if (
        !navigationReplacement &&
        this._navigationMessage?.key != null &&
        message.key === this._navigationMessage.key
      ) {
        navigationReplacement = message;
      }
      messages.push(message);
      indices.push(i);
    }

    if (this._focusedMessage && !messageIndices.has(this._focusedMessage)) {
      this._focusedMessage = focusedReplacement;
    }
    if (this._navigationMessage && !messageIndices.has(this._navigationMessage)) {
      this._navigationMessage = navigationReplacement;
    }
    if (this._detailsMessage && !messageIndices.has(this._detailsMessage)) {
      this._detailsMessage = null;
    }
    this._visibleCache = {
      sorted,
      generation: this._filterGeneration,
      messages,
      indices,
      messageIndices,
    };
    return messages;
  }

  // The index into the sorted list of the row at this visible index.
  _sortedIndexFor(visibleIndex) {
    this._visibleMessages();
    return this._visibleCache.indices[visibleIndex] ?? visibleIndex;
  }

  // Null during the first render: etch calls `render` before it has an element
  // to hand back, and the window arithmetic degrades to "render everything".
  _scrollContainer() {
    return this.element?.querySelector("tbody") ?? null;
  }

  // The height of one row, in pixels, cached in `_rowHeight`.
  //
  // Measured from a row that is already on screen rather than read from the
  // custom property that sets it: a custom property's value comes back as the
  // token that was written, so `2.1em` would parse as two pixels. Every row is
  // the same height by construction, so any of them will do.
  _measureRowHeight() {
    if (this._rowHeight) return this._rowHeight;
    const row = this.element?.querySelector(".diagnostics-row");
    const height = row?.getBoundingClientRect().height ?? 0;
    if (height > 0) this._rowHeight = height;
    return this._rowHeight;
  }

  _observeRow() {
    if (!this._resizeObserver) return;
    const row = this.element?.querySelector(".diagnostics-row") ?? null;
    if (row === this._observedRow) return;
    if (this._observedRow) this._resizeObserver.unobserve(this._observedRow);
    this._observedRow = row;
    if (row) this._resizeObserver.observe(row);
  }

  // Extra rows rendered above and below the viewport, so a scroll of a row or
  // two costs nothing.
  static get OVERSCAN() {
    return 40;
  }

  // Recycle rows in blocks so small wheel steps share the same render window.
  static get BLOCK_ROWS() {
    return 10;
  }

  // How many rows the very first render puts up. There is no row to measure
  // yet, so the window cannot be computed — but rendering the whole list to
  // find that out is the thing being avoided. `update` measures and corrects
  // as soon as this paints.
  static get BOOTSTRAP_ROWS() {
    return 200;
  }

  // Whether anything can see the panel. Three ways it can be out of sight, and
  // the element only knows about two of them:
  //
  // - it is not in the document at all, because the panel has never been opened;
  // - a pane is hiding it, which is how another tab of the same pane shows;
  // - the dock holding it is closed — and a closed dock is a zero-sized mask
  //   over content that keeps its own size, so nothing about the element says so.
  //
  // Deliberately not a size test: an unstyled panel is visible and measures
  // zero, and that is the case BOOTSTRAP_ROWS exists for.
  _isOnScreen() {
    if (!this.element?.checkVisibility()) {
      return false;
    }
    // Not a pane item at all — whoever put the element in the document is
    // showing it. Only a spec or an embedder takes this path.
    if (!lumine.workspace.paneForItem(this)) {
      return true;
    }
    const container = lumine.workspace.paneContainerForItem(this);
    return typeof container?.isVisible === "function" ? container.isVisible() : true;
  }

  // Which slice of the visible list to render.
  _visibleWindow(total) {
    // Nothing on screen wants a row. Every publish used to put up a full
    // bootstrap window here — 200 rows, markdown and all — for a panel nobody
    // had opened. The ResizeObserver below brings it back when it gains a box.
    if (!this._isOnScreen()) {
      return { start: 0, end: 0 };
    }
    // The live table has no box on the first render back from details.
    // The saved viewport lets that render build the right rows and spacers.
    const viewport = this._listViewport ?? this._scrollContainer();
    const rowHeight = this._measureRowHeight();
    if (!viewport?.clientHeight || !rowHeight) {
      return { start: 0, end: Math.min(total, Diagnostics.BOOTSTRAP_ROWS) };
    }

    const count = Math.ceil(viewport.clientHeight / rowHeight);
    // A resize or a shorter message list can leave scrollTop beyond the new
    // list until the DOM is patched. Keep the rendered slice inside the list
    // so its spacers cannot perpetuate that stale scroll height.
    const first = Math.min(
      Math.max(0, total - count),
      Math.max(0, Math.floor(viewport.scrollTop / rowHeight)),
    );
    const block = Diagnostics.BLOCK_ROWS;
    const start = Math.max(0, Math.floor((first - Diagnostics.OVERSCAN) / block) * block);
    const end = Math.min(total, Math.ceil((first + count + Diagnostics.OVERSCAN) / block) * block);
    return { start, end };
  }

  // Scrolling only redraws when it has actually changed which rows belong on
  // screen. Without this the panel would re-render on every wheel tick.
  _onScroll() {
    if (this.destroyed || this._detailsMessage) return;
    const total = this._isOnScreen() ? this._visibleMessages().length : 0;
    const next = this._visibleWindow(total);
    if (next.start === this._window.start && next.end === this._window.end) return;
    return this.update();
  }

  // Keyboard navigation starts from the editor's current message even when
  // manual scrolling has moved its row outside the rendered viewport.
  _currentMessage() {
    return this._visibleMessages()[this._currentRowIndex] ?? null;
  }

  _setFocusedMessage(message) {
    this._focusedMessage = message;
    this.update().then(() => this.scrollToFocused());
  }

  _moveFocus(delta) {
    const visible = this._visibleMessages();
    if (!visible.length) return;
    lumine.scrollbars.reveal(this.refs.scrollport);
    const clamp = (index) => Math.min(visible.length - 1, Math.max(0, index));
    const focusedIndex = this._visibleCache.messageIndices.get(this._focusedMessage) ?? -1;
    let index;
    if (focusedIndex >= 0) {
      index = clamp(focusedIndex + delta);
    } else {
      // First press: step off the current row when there is one, enter the
      // list from the end the key came from otherwise.
      const current = this._currentMessage();
      const currentIndex = this._visibleCache.messageIndices.get(current) ?? -1;
      if (currentIndex >= 0) {
        index = clamp(currentIndex + delta);
      } else {
        index = delta > 0 ? 0 : visible.length - 1;
      }
    }
    this._setFocusedMessage(visible[index]);
  }

  _moveFocusDown() {
    this._moveFocus(1);
  }

  _moveFocusUp() {
    this._moveFocus(-1);
  }

  async _navigateMessage(delta) {
    if (this.destroyed || this._navigating) return;
    const visible = this._visibleMessages();
    if (!visible.length) return;
    if (!this._focusedMessage && !this._navigationMessage) this._updateCurrentRowHighlight();
    const anchor = this._focusedMessage ?? this._navigationMessage ?? this._currentMessage();
    const current = this._visibleCache.messageIndices.get(anchor) ?? -1;
    const index =
      current < 0
        ? delta > 0
          ? 0
          : visible.length - 1
        : (current + delta + visible.length) % visible.length;
    const message = visible[index];
    const viewMode = this.pkg.viewMode;
    const editor = this.editor;
    this._navigationMessage = message;
    this._focusedMessage = null;
    this._navigating = true;
    try {
      await this.update();
      if (
        this.destroyed ||
        this.pkg.viewMode !== viewMode ||
        (viewMode === "file" && this.editor !== editor)
      )
        return;
      this._visibleMessages();
      const target = this._navigationMessage;
      const targetIndex = this._visibleCache.messageIndices.get(target);
      if (targetIndex === undefined) return;
      lumine.scrollbars.reveal(this.refs.scrollport);
      this._scrollIndexIntoView(targetIndex);
      if (viewMode === "project") {
        return await this._openMessage(target);
      }
      return await this.pkg.revealMessage(target);
    } finally {
      this._navigating = false;
      if (!this.destroyed) await this.update();
    }
  }

  _clearMessages() {
    if (this.destroyed || this._navigating || !this.pkg.hub || !this.pkg.messages.length) return;
    return this.pkg.clearMessages();
  }

  // Enter needs a cursor, jumps to its message, and takes the cursor with it.
  _confirmFocused() {
    this._visibleMessages();
    const message = this._focusedMessage;
    if (!message) return;
    lumine.scrollbars.reveal(this.refs.scrollport);
    this._navigationMessage = null;
    this._setFocusedMessage(null);
    if (this.pkg.viewMode === "project") {
      return this._openMessage(message);
    } else {
      return this.pkg.revealMessage(message);
    }
  }

  // Project mode navigates to a message that may belong to any file, so it opens
  // one. A message located by buffer has no path to open: it can only be
  // revealed in an editor that is still showing that buffer.
  async _openMessage(message) {
    const buffer = message.location.buffer;
    if (buffer) {
      const editor = editorForBuffer(buffer);
      if (!editor) return;
      const opened = await lumine.workspace.open(editor, { searchAllPanes: true });
      if (!opened) return;
      editor.setCursorBufferPosition(message.location.position.start, { mode: "zone" });
      editor.element.focus();
      return;
    }

    return lumine.workspace.open(message.location.file, {
      initialLine: message.location.position.start.row,
      initialColumn: message.location.position.start.column,
      pending: true,
      searchAllPanes: true,
    });
  }

  _cancelFocus() {
    this._setFocusedMessage(null);
    const editor = lumine.workspace.getActiveTextEditor();
    if (editor) editor.element.focus();
  }

  toggleFocus() {
    if (this.element.contains(document.activeElement)) {
      this._cancelFocus();
      return Promise.resolve();
    }
    // Focus only: the cursor does not exist until the first arrow press.
    return lumine.workspace.open(this, { searchAllPanes: true }).then(() => {
      this.element.focus();
      return this.update();
    });
  }

  scrollToFocused() {
    if (!this._focusedMessage) return;
    this._visibleMessages();
    this._scrollIndexIntoView(this._visibleCache.messageIndices.get(this._focusedMessage) ?? -1);
  }
}

function compareMessagePosition(a, b, byFile) {
  if (byFile) {
    // Grouped by whatever the row is labelled with, so pathless messages sort
    // together rather than all landing at the front under an empty string.
    const fileA = messageSubject(a);
    const fileB = messageSubject(b);
    if (fileA < fileB) return -1;
    if (fileA > fileB) return 1;
  }

  const cellA = a.location.cell;
  const cellB = b.location.cell;
  if (cellA != null || cellB != null) {
    const valueA = cellA == null ? -1 : cellA;
    const valueB = cellB == null ? -1 : cellB;
    if (valueA !== valueB) return valueA - valueB;
  }

  const startA = a.location.position.start;
  const startB = b.location.position.start;
  if (startA.row !== startB.row) return startA.row - startB.row;
  return startA.column - startB.column;
}

function throttle(func, timeout) {
  let timer = false;
  return function (...args) {
    if (timer) {
      return;
    }
    timer = setTimeout(() => {
      func.apply(this, args);
      timer = false;
    }, timeout);
  };
}

module.exports = { Diagnostics };
