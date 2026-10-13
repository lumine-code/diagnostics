# linter-panel

Show lint messages in a sortable panel and on the status bar.

Fork of [steelbrain/linter-ui-default](https://github.com/steelbrain/linter-ui-default).

The front end for the [linter](https://github.com/lumine-code/linter) package. Without it the linter still underlines, marks the gutter and answers hovers; with it every message the project holds is one list away.

## Features

- **Sortable panel**: a table of every message, sorted by severity, position or provider, with a filter per severity and a keyboard cursor once the panel has focus.
- **File and project view**: show only the active item's messages, or everything the project holds.
- **Status bar**: a count per severity, which switches view mode on a middle click and opens the panel on a left click.
- **Message detail**: each row carries the provider's long form beside the excerpt, such as a rule code, resolving a lazy one on demand and linking out to the provider's documentation.
- **Notebook positions**: a message that names a cell is labelled and sorted by it, so a diagnostic in a notebook reads as `[cell]:line:col`.
- **Windowed rendering**: only the rows the viewport can show are built, so a project with tens of thousands of messages costs what one screen costs.

![Inspect a TypeScript error in the diagnostics panel and its source code.](.github/demo.png)

## Installation

To install `linter-panel` search for it in the Install pane of the Lumine settings, or run the command `lumine --install lumine-code/linter-panel`.

## Commands

Commands available in `lumine-workspace`:

- `linter-panel:toggle`: show or hide the panel,
- `linter-panel:toggle-focus`: focus the panel, or hand focus back to the editor,
- `linter-panel:file-mode`: show only the messages of the active item,
- `linter-panel:project-mode`: show the messages of the whole project.

Commands available in `.linter-panel`:

- `linter-panel:copy-description`: copy the message under the pointer, with its long form,
- `linter-panel:copy-details`: copy the whole message as JSON.

## Customization

Restyle the panel from your `styles.css`:

```css
.linter-panel {
  --linter-row-height: 2.6em;

  .linter-row.current {
    background-color: var(--background-color-selected);
  }

  .linter-excerpt {
    font-family: var(--editor-font-family);
  }
}
```

The row height is read back in JavaScript to decide how many rows the viewport wants, so it has to resolve to a length.

Left-click the status counter to toggle the panel, middle-click to switch file/project mode, Cmd/Ctrl-click to go to the next message, and Shift-click to go to the previous one. Right-click for the complete action menu, including focusing the panel and clearing messages.

## Services

- `linter.ui`: provided to receive the messages the linter holds, and the handle it answers questions about them through.
- `status-bar`: consumed to show the message count per severity.

## Contributing

Got ideas to make this package better, found a bug, or want to help add new features? Just drop your thoughts on GitHub. Any feedback is welcome!
