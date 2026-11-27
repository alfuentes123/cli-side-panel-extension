# CLI Side Panel

A VS Code extension that opens CLI tools and terminals in the Secondary Side Bar. Completely separate from VS Code's built-in Terminal so your bottom panel terminal can stay right where it is.

<img width="1439" height="864" alt="cli-side-panl" src="https://github.com/user-attachments/assets/ce0334c7-ed32-4691-ba0e-630a709a6200" />

## Features

- **Secondary Side Bar native container**: Lives in the right-hand Secondary Side Bar independently of the built-in Terminal view.
- **Multi-tab bar starting empty**: Opens cleanly with no tabs until you create one. Each tab runs its own independent session and preserves state/scrollback while hidden.
- **New Tab launch dropdown**: Clicking `+` (or **New Terminal**) shows a dropdown with **"Empty terminal"** plus any command launch presets you configure.
- **Workspace-aware**: Automatically opens in your active workspace folder (falling back to the first workspace folder, or your home directory if no folder is open).

**Cursor users:** Cursor does not let an extension install in the secondary side bar, so it starts in the Explorer tab of the primary side panel when first installed (you can find it with `CTRL + SHIFT + P` and typing `CLI Side Panel: Focus`), to move it to the chat panel: Drag the extension into the Activity bar → right click it → move to → secondary side bar.

## Extension Settings

Add your preferred CLI tools using the following format:

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
