# CLI Side Panel

A simple VS Code extension that opens CLI tools and terminals in the Secondary Side Bar. Completely separate from VS Code's built-in Terminal so your bottom panel terminal can stay right where it is.

Side-panel version of [CLI View](https://github.com/alfuentes123/cli-view-extension). 

## Features

- **Secondary Side Bar native container**: Lives in the right-hand Secondary Side Bar independently of the built-in Terminal view.
- **Multi-tab bar starting empty**: Opens cleanly with no tabs until you create one. Each tab runs its own independent session and preserves state/scrollback while hidden.
- **New Tab launch dropdown**: Clicking `+` (or **New Terminal**) shows a dropdown with **"Empty terminal"** plus any command launch presets you configure.
- **Workspace-aware**: Automatically opens in your active workspace folder (falling back to the first workspace folder, or your home directory if no folder is open).


## Extension Settings


**Example** 

```json
{
  "cliSidePanel.launchOptions": [
    {
      "name": "Claude Code",
      "command": "claude"
    },
    {
      "name": "Gemini CLI",
      "command": "gemini"
    },
    {
      "name": "Dev Server",
      "command": "npm run dev",
      "cwd": "packages/web"
    }
  ]
}
```

Each launch option accepts:
- `name` *(required)*: Label shown in the dropdown and tab bar.
- `command` *(required)*: Command sent automatically when the tab starts.
- `shell` *(optional)*: Custom shell executable override for this preset.
- `shellArgs` *(optional)*: Custom shell arguments override for this preset.
- `cwd` *(optional)*: Absolute path, or path relative to the current workspace folder.


## License

MIT
