# Dozo for macOS, Windows and Linux

A small native window around the Dozo web app, written in Rust with Tauri 2. It is the fork's own
shell. Upstream's Electron app in `apps/desktop` is separate and is neither edited nor renamed.

## What it does

- The first launch asks for the server (default `https://app.dozo.bot`, or one click for the
  server on this computer, which the app downloads, sets up and runs itself: "The server on this
  computer" below). The choice is saved and can be changed from
  the menu (Dozo, Change Server…) or from Settings.
- A server that cannot be reached gives a screen with Try again and Change server, not a blank page.
- Standard macOS menus (About, Settings…, Change Server…, Reload, Quit, and the Edit menu's
  shortcuts). The window comes back at its last size and position.
- Settings (Dozo, Settings…, Cmd+,; Ctrl+, on Windows and Linux): one window that lists what the
  Dozo menu offers right now, switches first. See "Settings" below.
- Let Bots Use This Computer (in the Dozo menu): the person's own bots can run commands on this
  computer instead of a hosted one. See "Bots on this computer" below.
- Links to other sites open in the default browser. Downloads go to the Downloads folder. File
  inputs open the system file dialog. The session survives a restart: cookies and site storage are
  kept by the system web view.

## What it leaves out

- It does not imitate upstream's desktop bridge, so the web app behaves as it does in a browser:
  no update section, no in-chat search bar, no custom window buttons. Upstream's native features
  (its own server on this computer, Docker management) are not here; the server on this computer
  and updates are the app's own (below). Bots using this computer is the app's own too (below), with a menu item
  and a row in Settings rather than a switch in the web app's settings, which only that bridge
  would show.
- Anything that leaves the server's origin opens in the browser. A sign-in that redirects to
  another site therefore finishes in the browser, not in the app; sign in with email and password.
  The one exception is the hosted account's sign-in on the server on this computer (below).
  A link that asks for a new window also opens in the browser, even on the same origin.
- The server address must be the one the pages are served from. An address that redirects to
  another host (a bare domain to `www.`) opens the browser and ends on the "Can't reach" screen.
- Camera, location and similar requests from a page are denied. The microphone and notifications
  are allowed for the server's own origin only (below).
- Links to the browser are limited to one a second, so a page cannot flood it.
- The menus and the Settings window are in Turkish when the system's language is Turkish, and in
  English otherwise (`src/words.rs`). The other local screens are English only.

## Settings

- One window (`src/prefs.rs`, page `ui/prefs.html`) with every item of the Dozo menu that is on
  right now, switches first, under the menu's words and in its state: Let Bots Use This Computer,
  Open at Login, Keep Running in Background, Push to Talk, Change Server…, and, while the server on this
  computer runs, Connect Phone…, Back Up…, Restore…, Reset Password…, Save Diagnostics… and its
  Licenses (the bundle's third-party notices, in the browser). Restart to Update is there while an
  update waits. The app's version is at the bottom.
- The list is read from the menu itself, so an item added to the Dozo menu shows here too, and
  picking a row does exactly what picking the item does (`run` in `src/main.rs`). Reload, Quit and
  Settings… stay in the menu only. The window reads the list again when something it shows
  changes, never on a timer.
- The menu items all stay where they were; Cmd+, (Ctrl+,) now opens Settings instead of Change
  Server. Change Server… also brings the app window forward, as it is picked from Settings too.
- In the app, the web app's settings show a "Desktop app" row (General) and, while no computer of
  the account is connected, "Connect this computer" (in General's Computers group). Both go to `dozo-app://settings`,
  which the window answers by opening Settings and nothing else; see Security. In a browser they
  are not shown: only the app's window sets `window.dozoDesktopShell` before a page loads.

## The microphone

The server's page may use the microphone, so dictation (hold the microphone in the composer) and
calls work as in a browser. Nothing else may: the decision is `answer` in `src/alerts.rs`, taken
when the page asks, for a page whose origin is exactly the chosen server's. A frame from another
origin is refused by the web view itself before it asks, as a browser refuses it without the
page's permission. The camera stays refused, and a request for the camera and the microphone
together is refused whole. The page asks only when the person starts dictation or a call.

The system decides as well, once per app, and its answer is what counts:

- macOS: the first request shows the system's question with the sentence in `Info.plist`
  ("Dozo uses the microphone only while you talk to your bots."); the app's signature carries the
  hardened runtime's microphone entitlement (`Entitlements.plist`). A refusal, there or later in
  System Settings, Privacy & Security, Microphone, reaches the page as a denied request and the
  composer shows its own error. Web speech recognition is not offered to the page (no speech
  recognition usage description), so dictation goes to the server's voice provider. Not built or
  tried on a Mac yet.
- Windows: Settings, Privacy & security, Microphone, "Let desktop apps access your microphone"
  decides; the system shows its microphone icon in the taskbar while it is in use. Compiled, not
  tried.
- Linux: no system question. WebKitGTK has media capture off until the app turns it on
  (`src/microphone_gtk.rs`), and records through GStreamer from PulseAudio or PipeWire. Tried by
  `tests/linux_gate.py` against a PulseAudio sine source: the server's page gets the microphone,
  a frame from another origin and a camera request do not.

While the microphone is open, the system shows it: the menu bar indicator on macOS, the taskbar
icon on Windows, and on Linux the desktop's own indicator where it has one (GNOME 41 and later).
The app adds no indicator of its own; Push to Talk brings the window forward, so the composer's
recording strip is in view as well.

## Push to Talk

A switch in the Dozo menu, off until chosen: Push to Talk (⇧⌘Space on macOS, Ctrl+Shift+Space on
Windows and Linux; the label names the keys). While on, the shortcut works with another app in
front. Held down, it brings the window forward and starts the composer's dictation, the same one
its microphone button starts; let go, it sends what was heard. No other voice path was added.

- The app has no bridge into the page: on the server's page only, it dispatches a `dozo-talk-key`
  window event (`down` or `up`) and reads nothing back (`src/talk.rs`). The web app's composer
  answers it (`apps/web/src/components/composer/dozo-hold-to-talk.ts`, reached through one
  anchored rule in `composer.tsx`): only the newest composer on screen, and only where its
  microphone could work. With no voice provider that transcribes and no recognizer in the web
  view, the shortcut only brings the window forward and the microphone stays closed.
- Refused shortcuts are said, not swallowed: when the system or another program already holds
  the keys, the switch goes back off, is saved off, and a message names the keys. The same
  happens at launch if the keys were taken since. On a Wayland desktop an app cannot have a
  shortcut that works while another app is in front, so the switch is refused there with a
  message (an app forced onto X11 with `GDK_BACKEND=x11` may use it).
- Saved as `push_to_talk=true` in the settings file below; missing means off. Registered from the
  app's Rust code only: no page is granted the shortcut plugin's commands.

Per system:

- Linux (X11): tried by `tests/linux_gate.py`: the shortcut reaches the server's page down and up,
  a frame from another origin hears nothing, the shortcut brings back a closed window, and a
  shortcut another program holds turns the switch off with a message.
- Windows: compiled, not tried. The system refuses keys another app registered, which is reported.
- macOS: not built or tried yet. macOS does not always refuse keys the system or another app uses,
  so there a clash may show only as the shortcut doing nothing.

## Open at Login and Keep Running in Background

Two switches in the Dozo menu, both off until chosen. Each is saved in the same file as the server
address (`server`, in the app's config folder): the address on the first line, then
`open_at_login=` and `keep_running=` lines. A file with the address alone, as older versions
wrote it, still reads, and a missing switch is off. The other way does not: a version from before
these switches cannot read the new file and asks for the server again. The file is written to a
`.tmp` beside it and renamed, so a crash never leaves half an address. They are menu events handled in Rust: no
command was added and `capabilities/local.json` is unchanged.

- Open at Login uses the system's own entry (a macOS launch agent, the Windows `Run` key, a Linux
  XDG autostart file), started with `--from-login`. The entry is the system's: at every launch the
  menu and the file are set to what it says, so one removed from outside shows as off.
- Keep Running in Background off: closing the window quits, as it always did.
- On: closing hides the window on macOS (the Dock icon shows it again). On Windows and Linux it
  hides to a tray icon (Open Dozo, Quit Dozo; a click on Windows shows the window). Where no tray
  icon can be clicked, the window is minimized instead and never hidden. Linux counts a tray as
  there only when something on the desktop hosts tray icons (GNOME needs an extension), and asks
  again at each close.
- A start from the login entry has no window only when the switch is on and the window can be
  brought back (the Dock, or a tray that shows); otherwise the window opens as usual. The window's
  last visible state is never restored, so a hidden exit never makes the next start hidden.
- Quit in the menu ends the app on every system, and so does Quit Dozo in the tray.
- A second launch starts no process: the running app shows its window and brings it forward, hidden
  or minimized (one started by the login entry is ignored). Without a session bus on Linux, a
  second app simply starts.
- The update check and Restart to Update work with the window hidden: once an update is waiting,
  the item is also at the top of the tray's menu. Restarting into an update always opens the
  window, even though the restarted process carries the login entry's argument (a `restarted` file
  beside `server` says so, and is gone once read). The restart releases the single-instance lock
  before it starts the new process (Tauri's `cleanup_before_exit`); this was read in the source,
  not run against a real update.
- Linux needs `libayatana-appindicator3` for the tray: the .deb depends on it, the AppImage carries it.
- macOS and Windows: compiled, not tried by hand. Only Linux runs under `tests/linux_gate.py`.

## Notifications and the unread badge

The web app's own notifications (a bot finished, asks a question or waits for approval, a run
failed) show as system notifications, and the number of unread chats sits on the app icon. The
page still cannot call the app: the system web view shows its notifications, and the count is
read from the page title, where the web app puts it as `(3) Dozo` (only the number; the rule in
`dozo/brand/brand.json` points `Shell.tsx` at `apps/web/src/lib/dozo-desktop-badge.ts`). No
setting, menu item, sound or text was added: the system's own notification settings apply.

- Permission: only for a page whose origin is exactly the chosen server's (scheme, host and port),
  decided by `answer` in `src/alerts.rs` at the moment the page asks, so after Change Server the
  new origin is the one that counts. The web view asks only for the window's own page: WebKitGTK
  and WebView2 refuse a frame from another origin themselves, and WebKitGTK also wants a click or
  key press behind the request (the web app asks when a message is sent). The Linux gate clicks a
  frame from another origin (denied) and one from the server's (granted). Every other permission
  stays denied.
- Badge: read only from a page on the server's origin; capped at `99+` on the Dock, at `9+` in the
  Windows taskbar overlay (an ink disc with white digits, drawn in `src/alerts.rs`), at 99 in a
  Linux launcher. Cleared at 0, and as soon as the window loads anything but the server (Change
  Server, the connection screens).
- A click on a notification brings the window back on Linux, hidden or minimized
  (`reveal_on_click`).

Per system:

- Linux (WebKitGTK). Notifications and the click: tried, by `tests/linux_gate.py`. Badge:
  compiled; it shows only where the desktop runs a launcher that reads libunity counts (Ubuntu
  Dock, KDE, Plank), and has not been seen.
- Windows (WebView2). Notifications and the badge (taskbar overlay): compiled, not tried. The
  click is not done: WebView2 shows the notification itself and tells the page, not the app.
- macOS (WKWebView). Notifications and the click: not done. WKWebView has no public way to grant
  a page notifications and refuses them; doing it would need private WebKit API or a bridge into
  the page. Badge (`set_badge_label`): written, not compiled on a Mac yet; the release workflow
  builds it.

Known limits:

- Linux keeps the grant only for the life of the web view's process: after a restart the page
  asks again with the next message sent, and nothing notifies before that.
- Windows keeps the grant in the web view's profile. An origin granted before Change Server keeps
  it there, though it can no longer be the window's page.

## Security

- A page loaded from a server can call nothing in the app. What reaches the app from it is the title
  (read for the unread count only), the notifications the web view itself shows, and a visit to
  `dozo-app://settings`, which opens the Settings window (below). The app's commands are under
  Tauri's ACL (`build.rs`), and its capabilities (`capabilities/*.json`) grant them to the app's own
  screens, each to its own window. None has a `remote` entry and none must ever get one. The
  dialog plugin's commands are granted to no page: only the app's Rust code opens its dialogs.
- Bots reach this computer only after the person allows it in the system dialog, which names the
  server and which no page can answer. The device token is kept in the system keyring, never in
  a file.
- Only the chosen server's origin and the app's own screens load in the window. Every other web
  address goes to the browser; `file:`, `data:` and unknown schemes are refused (`src/server.rs`).
- `http://` is accepted only for this computer (`localhost`, `127.0.0.0/8`, `::1`). Any other
  address must be `https://`.
- Frames inside the server's page load as they do in a browser (a bot's screen, an embedded page).
  Tauri's navigation hook cannot tell a frame from the window's own page, so `src/frames.rs` puts
  a small delegate in front of the web view's own to make that one distinction. On Linux
  (`src/frames_gtk.rs`) the web view does not say which frame a navigation is for, so a click is
  judged as the window's own page before anything is requested (a link clicked inside a frame
  opens in the browser too), other web navigations go ahead, and the window's own page is
  checked when its answer arrives: a refused page never shows, but its request has been sent.
  Without a click, nothing but a web address can be handed outside the app.
- The local screens are plain HTML, CSS and JavaScript in `ui/`, with a CSP that allows only their
  own files and forbids framing them.
- A page of the chosen server can open the Settings window, and nothing more: going to exactly
  `dozo-app://settings` (no path, query or fragment; any other `dozo-app:` address is refused)
  opens it when the window's page is on the chosen server's origin, at most once a second
  (`asked_by_page` in `src/prefs.rs`). It carries no data and cannot change or pick anything;
  only the person does, in that window. On Linux the web view does not say which frame asked
  (see frames above), so there it is the window's page that is checked.
- The Settings window's two commands (`capabilities/prefs.json`) are granted to that window only.
  A pick is checked against the list it shows now.

## Bots on this computer

Turning on Let Bots Use This Computer asks "Allow bots to use this computer?" in a system dialog
with the warning "A bot on <server> can read your files on this computer and run programs as
you." (Turkish on a Turkish system). Allow pairs this computer with the chosen server under the signed-in
account and connects to it; the web app's settings then list it under Computers as Connected.

- Protocol: upstream's paired computer, unchanged, so the server needs nothing new. The app posts
  the web view's sign-in cookie to `/api/devices/pair` (only to the chosen server's origin) and
  keeps the device token it gets back in the system keyring (`src/device_pairing.rs`). It then holds one outbound WebSocket to
  `/api/devices/connect` with that token (`src/device_socket.rs`); the server never connects in.
  On connecting it says what it can do (`x-dozo-device-capabilities: shell`), and the server
  offers a run only those tools (`packages/adapters/src/dozo-device-capabilities.ts`). A computer
  that says nothing, as 0.4.0 and older do, gets commands only.
  Lost connections come back with backoff; a ping every 30 seconds notices a silent drop. A
  dropped connection stops the commands in flight (their answers could not arrive), and what
  they left running gets 60 seconds to see it come back before its process groups stop.
- What a bot can do (`src/device_run.rs`): run commands and, through them, work with files.
  Commands arrive as an argument list and start without a shell in between (the server's own
  shell tool sends `<shell> -lc <command>`, as upstream does). They run as this user, in the
  bot's own folder or anywhere in the home folder; any other working folder is refused. They get
  only the usual shell variables of this app's environment, stop at their timeout, and each one
  leads its own process group. Screen control is not declared, so the server offers no screen
  tools; a screen request that arrives anyway is refused.
- What stopping a command reaches: its process group. On Linux each command also carries its own
  mark in its environment, so what it started in a new session or group (`setsid`, a double
  fork) is found in `/proc`; that is stopped only by an explicit stop (a run's cancel, the bot's
  stop, turning access off, quitting the app). A timeout or a dropped connection stops the group
  only and keeps tracking the rest, so turning access off or quitting later still stops it. A
  group is signalled only while a marked process is still in it. The limit: an app a command
  starts inherits the mark too, so a browser a bot opened (`xdg-open`, `firefox`) when none was
  running closes on such a stop; one that was already running only gets a new window and is not
  touched. There is no reliable way to tell an app the person now uses from a bot's own process.
  What a command hands to another manager is out of reach on every system: `systemd-run --user`,
  launchd, cron, `at`, a login item, or a process that clears its environment and leaves the group.
  On macOS, `setsid` and a double fork escape as well; on Windows, the process tree is stopped only
  while the command itself still runs. A finished command's leftovers are tracked (at most 256)
  and forgotten within a second of ending.
- The server's rules stay upstream's: only chats the person starts with their own bots reach this
  computer, never routines or other people's messages, and the first command in each Space asks
  in the chat first.
- Ends: turning the item off (at once: the connection and running commands stop and the answer
  is gone; then the token is revoked on the server and deleted here; if the server cannot be
  reached, the app says so and retries with backoff, at every launch and before turning it on
  again, which cannot pair until it succeeds; a server that no longer knows the token counts as
  done, and without the token the person's sign-in ends the pairing by its device id); removing the computer in the web app's settings; signing out or a password
  reset (the pairing ends; the same account's next sign-in pairs again on the next page load or
  when the window comes forward, another account is asked again); quitting the app (commands
  stop).
- The answer holds for one server and one account; another server starts switched off. Changes
  to the pairing run one at a time, each step bounded (network calls time out after 15 seconds,
  keyring calls after 10); the person is never asked while one runs. While another account's
  answer is asked for, its new pairing is held as a pending revoke. The menu's check mark always
  shows the saved answer.
- Keyring: macOS Keychain, Windows Credential Manager, the Secret Service on Linux (GNOME
  Keyring, KWallet). On Windows, Credential Manager does not separate apps: any program running as
  the same user can read the token. Without one, the app does not pair and says so, as upstream's app refuses to
  without secure storage; a plain file is never used for the token.
- While connected, the menu's check mark is the only sign in the app; the web app's settings
  show the computer as Connected. No extra indicator (a tray badge or a title): it would be one
  more always-visible element for a state the person turned on themselves. With Keep Running in
  Background, bots can still use this computer while the window is hidden.
- Plans: a paired computer is not a hosted one, so Free's missing computer hours do not affect it.
- Not done yet: screen control (macOS needs the Accessibility and Screen Recording permissions,
  which this app does not ask for). Only the Linux app has been run against a server; the
  Windows code compiles and runs its tests in CI, the macOS code is not built on a pull request.

## The bot's own browser

Not offered yet: the app does not declare it (`browser::DECLARED` is off) until the sign-in pause
comes, during which the person signs in and the app passes nothing on. Until then no server offers
it, and only the tests below reach it.

A bot on this computer can use a browser of its own: the Chrome, Edge, Brave or Chromium installed
here, started with a profile folder of that bot's own, never the person's (`src/browser.rs`). It
opens as a normal window with its address bar, so the person sees what the bot does and can type
into it.

- What the allowlist is for: the server's channel into the browser. A bot that may also run
  commands already runs them as the person and can reach anything they can, its browser profile
  included. The allowlist means most where the browser is offered without commands, or beside the
  per-command approval.
- The browser is looked for only where the system installs it (`/Applications` on macOS; `/opt`
  and `/usr/bin` on Linux, the first of Chrome, Edge, Brave and Chromium), never on `PATH` or in
  the home folder. It starts with only the variables a desktop browser needs, so nothing like
  `CHROMIUM_FLAGS` or `LD_PRELOAD` adds to it.
- The server side (`packages/adapters/src/dozo-device-browser.ts`): `pageBrowser` requests,
  each one DevTools command, give the bot its usual `browser_navigate`, `browser_snapshot` and
  `browser_act` with the same results as on its own computer, built from the page's accessibility
  tree, and a screenshot with a snapshot for a model that can see.
- Who gets it (`packages/adapters/src/dozo-user-browser.ts`): only chats the person starts with
  their own bot, as for commands, never a run a message sent with an access token reached, and
  only when the run has no graphical computer of its own (Free).
- What asks, in each thread anew: the bot's first use of its browser ("Let this bot use its own
  browser on your computer and open x.com?"), and the first time it opens, reads, acts on or has
  the person sign in to each site, each of those on its own ("Let this bot open x.com in its
  browser?", "... read ...", "... act on ...", "... have you sign in to ..."): allowing a look at
  a site allows no action there. Once content from outside has entered the run (a page it read, a
  fetched text), opening another site than the one the browser shows asks every time. This makes
  sending what the bot read elsewhere harder, not impossible: a site the person allowed can still
  pass the bot on (a redirect, a link, a form), and the request reaches the other site before the
  bot is told (see "What stays possible" below). A page whose site cannot be told is asked about
  before it is read; a blank one is not. An answer holds for that bot, on this computer, in that
  thread; the card's site is kept with the call, and a call resumed after the page moved elsewhere
  is refused. What a call returns is the page it ended on, and only a page of the site it was
  approved for is given: a navigation or action that ended on another site says where and gives
  nothing of it, a look at a page another thread's run moved (a blank one included) is refused,
  and a batch stops when a step took the page elsewhere. A call that reached this computer without its approval
  having seen it is refused. Saved logins, cards and uploads do not reach this browser yet.
- Signing in: the bot never types a password or a code there. With `browser_sign_in` it names a
  site; this app opens that site's home page in the bot's window (never an address the bot gives)
  and shows the person a small system dialog of its own: "Sign in to x.com in the bot's browser
  window, then choose Done. Until you choose, for up to 15 minutes, the bot sees nothing there."
  with Done and Cancel. Until they answer, every command for that bot's browser is refused (no
  page, screenshot, input, navigation or history); no bot runs a new command on this computer, and
  the commands already running here, any bot's, are held (their process groups stopped) and let
  go after, since a command could read the screen. Stopping the bot leaves its browser open
  meanwhile; deleting it ends the sign-in. When they answer, the page goes to the site's home page
  (Done) or a blank page (Cancel) and the tab's history is cleared, before the bot has it again:
  neither a return address with a code, nor a half-done step, nor a way back to them reaches the
  server, and the sign-in's events are dropped. The bot learns whether they signed in, and then
  sees the site's home page as anyone signed in would. Only the person ends it; after 15 minutes
  without an answer, if the browser closes, or if the bot is deleted, it counts as cancelled and a
  second dialog says so: "The sign-in to x.com ended without your answer: the bot has its browser
  again, and Done or Cancel there no longer does anything." (the first cannot be closed by the
  app). A request the server or the run
  gives up on leaves it as it is. Every site asks a card first, in each thread; a site whose name
  imitates another's (paypa1.com) gets the same card and dialog, named as it is. Device request:
  `pageBrowserSignIn`.
- Screenshots: a model that can see gets one with each snapshot. Like any image a tool returns, it
  is kept with the thread's run history and not redacted (text is); it goes when the thread does.
- The connection is the browser's debugging pipe (`--remote-debugging-pipe`), never a port:
  nothing listens on TCP, so nothing on the network and no program running as another user can
  connect to it.
- Only the commands in `ALLOWED` pass, with only the parameters listed there, and only to the
  bot's one page: reading the accessibility tree, the page's boxes, mouse, keys and text, going to
  a website, back and forward, and screenshots of the visible page. Refused before they reach the
  browser, so none of it reaches the server: reading cookies or site storage, running script
  (`Runtime.evaluate`), a debugging session, uploads, bringing the window forward, the middle,
  back and forward mouse buttons, and keys that reach past the page's text (Alt with anything,
  Ctrl or Cmd with anything but select all, undo and moving or deleting by word, the clipboard
  keys: Ctrl or Cmd with V, C or X, Shift with Insert or Delete, Ctrl with Insert; function and
  browser keys). With Ctrl, Cmd or Alt only the key itself is sent, no text or system key code.
  Numbers must be whole where the browser reads whole numbers. Downloads are refused. A command
  whose page left the web while it ran (a click on a link) has its answer dropped.
- Websites only, enforced on the network: every request of the bot's browser, pages, frames,
  scripts' requests, forms, redirects and web sockets, goes through this app's own proxy on
  loopback (`src/browser_proxy.rs`, `--proxy-server`, loopback not bypassed, no WebRTC around it).
  The proxy resolves each name itself, refuses one that names or resolves to this computer or its
  network (loopback, private, link-local, shared, benchmark and reserved ranges and their IPv6
  forms, `localhost`, single-label names and the names local networks use, such as `.local`,
  `.lan`, `.home.arpa`, `fritz.box`), and connects to the address it checked, so a name that
  changes its answer (DNS rebinding) does not get through either. A refused and a failed
  connection get the same answer, so a page cannot tell which ports answer. This computer's own
  addresses and the networks it is on directly are refused too, public ones included, and so is
  the server on this computer. Plain HTTP passes one request per connection: the browser does send
  more on a connection it used (measured), which the proxy closes so the request comes again
  through the check. At most 256 connections at once for all bots together: one past that is
  closed at once, so that request fails in the page; one idle for five minutes is closed. When this
  computer's networks cannot be read (and on Windows, which has no browser yet), nothing outside
  is let through. The address the bot opens is checked the same way first.
- While the bot's tab shows anything else (the person sent it to the browser's own pages or a
  file), only going to a website works, and its history and events leave such addresses out. The
  bot's tab is the one the browser opened with; once the person closes it, the bot always gets a
  new blank tab, never another (the person's, or a window a page opened).
- A click the server sends counts as the person's gesture. The app denies pages the clipboard API
  and the browser's prompts (notifications, location, camera, microphone and the like) and, with
  its own guard, the copy and cut commands, every form of full screen (one a video's own controls
  start is left at once), picture-in-picture windows, pointer lock, the file and folder pickers,
  printing, passkeys and payment sheets. A page cannot undo the guard: what it relies on is taken
  before any page script runs. The guard is
  set before any script of every document, and every new tab, window and frame of its own process
  holds until it has it (`Target.setAutoAttach`); it also guards a window a page opens and a frame
  it reaches, so a page cannot call the browser's own functions through them. A page can still open
  a window or tab with such a click (sign-ins need it); the bot cannot reach it, and while it is in
  front the bot's page is behind it. A link to another program (`mailto:`, a meeting app) asks the
  person first.
- None of Playwright's defaults that mark the browser as automated or store its passwords
  unencrypted (`--enable-automation`, `--use-mock-keychain`, `--password-store=basic`), no `--app`
  or kiosk mode.
- Profiles live in the app's data folder, `computers/browser-profiles/<bot>`, open to this user
  only (mode 700). Deleting the bot ends its browser, waits for it, then deletes its profile; a
  browser that would not end keeps it. A bot deleted while this computer was offline keeps its
  profile until a later sweep (not built yet).
- The browser ends when access is turned off, the bot is stopped, or the app quits. On Linux it
  also ends with a crashed app (`PR_SET_PDEATHSIG`); elsewhere the closed pipe ends it, and the
  next start on that profile ends what is left first. A dropped connection keeps it open.
- What stays possible, in plain words:
  - A site the bot may act on gets everything the bot types there.
  - A site the person allowed can pass the bot on to another site (a redirect, a link, a form)
    and so send that site what is in its address; the bot is told only afterwards and sees
    nothing of the other site until it is allowed.
  - On Linux, text a page selects can land in the system's selection, which a middle click
    elsewhere pastes.
  - Some of the browser's own choosers may appear in the bot's window: device pickers (USB,
    Bluetooth, serial, HID), the screen-sharing picker, the share sheet, a site asking to open
    links of a kind, and the right-click menu. They are for the person; the bot cannot answer them.
  - Public addresses reached only through a split-tunnel VPN are not filtered.
  - Any program running as you, a command you allowed a bot to run included, can read the bot's
    browser profile and its sign-ins.
  - One bot's pages can use up the proxy's connections for a while and make other bots' pages
    fail meanwhile.
- Honest limits: anything running as this user, the bot's own commands included, can read the
  profile folder, and on Linux can open the browser's pipe through `/proc` and send it any
  command. Anyone on this computer can use the proxy, which reaches only what they already can.
  Synthetic keys did not reach the browser's shortcuts in Chrome 158 on Linux (measured); they are
  refused anyway, and macOS was not measured. On macOS the pipe is made and then marked close-on-exec, so a command
  started in that instant could inherit it. `/Applications` is writable by admin accounts. A
  stopped bot starts no browser. A Snap Chromium is passed over. Windows: not yet.
- Proof: `tests/stack_e2e_native.sh` step 0, on Linux in a real window under Xvfb and on macOS,
  with the browser on the runner: the page tools, refusals, the guard in windows, added frames,
  a frame of another site and the older full screen, nothing reaching this computer through a
  picture, a script's request, a form, a redirect or a rebound name, a tab moved off the web or
  closed, the profile, no TCP port, ending with a killed app and with a deleted bot.

## The server on this computer

"Use the server on this computer" makes the app install and run a Dozo server for this user alone,
with no Docker: Node, Postgres and the server bundle as plain processes
(`dozo/server-bundle/README.md` is the contract). Linux x64 runs it, and Windows x64 runs it in CI
end to end (below); the code builds for macOS, where it has run by hand only.

- First use downloads the manifest and the three parts (190 to 240 MB depending on the system: server, Node and Postgres), checks each one's size and
  sha256, unpacks it in a folder beside its place and moves it in with one rename. A download cut
  off goes on from where it stopped next time (an HTTP range); one whose sha256 differs is deleted.
  An archive entry that would land outside its folder (`..`, an absolute path, a link pointing
  out) refuses the whole archive. Later starts use what is installed and need no network.
- The manifest is the one of the server version this app was built for (`MANIFEST` in
  `src/stack.rs`). `DOZO_SERVER_MANIFEST`, at build time or in the environment, names another: an
  `https://`, `http://` or `file://` address, or a path (tests and development).
- Start: Postgres (made on the first start), the migrations, then the API, the worker and the web
  server; ready once `/health` and the web page answer 200 (at most two minutes). The window then
  opens the web address and keeps it as the chosen server. One line shows where it is
  (Downloading 42%, Preparing, Starting); a failure shows one sentence and Try again. Details go to
  `logs/manager.log`.
- Postgres runs in UTC (`-c timezone=UTC` at every start), whatever this computer's zone:
  `initdb` wrote that zone into the data folder, and the server's SQL expects UTC.
- In-app feedback goes to the address a build names (`DOZO_FEEDBACK_EMAIL`, passed to the API);
  without one it is only kept on the server.
- Everything listens on 127.0.0.1 only. The ports are picked free on the first start and kept;
  Postgres and the API move when another program took theirs. The web port is the pages' origin
  (their sign-in and site data), so it never moves: if it is taken, the start stops and says so.
- Secrets (the Postgres passwords, the auth and screen secrets, `ENCRYPTION_KEY`, the
  single-account token) are made on the first start and kept in `secrets`, readable by this user
  only. A value is never replaced; a key a later version adds is.
- A process that exits on its own starts again after 1 s, then 2, 4 … at most 30 s; back to 1 s
  after a minute up. Its output goes to `logs/<name>.log`, cut to a fresh file past 5 MB, one
  older file kept.
- Stop: the web server, the worker, the API and the relay agent together, then Postgres; each
  asked first (Node TERM, Postgres INT, its fast shutdown) and killed with what it started after
  10 s (the API 25 s, as it lets requests finish for 20 s; Postgres 20 s). Quitting waits for it, at most a minute; so does
  Restart to Update. Choosing another server stops it.
- Nothing is left behind: on Linux each process ends with the app however the app ends
  (`PR_SET_PDEATHSIG`: Node is killed, as nothing is left to wait for its graceful stop; Postgres
  gets its fast shutdown), and each holds the folder's lock (`stack.lock`), so a second app, or a
  restart while something is still left, gets "Another Dozo is already running the server on
  this computer." instead of a second server on the same database. Elsewhere (macOS) a crash of
  the app leaves them running and they hold no lock, so every start leaves each process's pid in
  `run/<name>.pid`, and the next start first ends, with its process group, each one still running
  a program from `versions/` (asked, then killed after 10 s); a pid now used by anything else is
  left alone (the program is checked: `/proc/<pid>/exe` on Linux, `ps -o command=` elsewhere).
  CI runs it on macOS (Apple silicon and Intel) and on Linux with `PR_SET_PDEATHSIG` turned off
  (`tests/stack_e2e_native.sh`).
  Windows: each process runs in a job object of its own, which ends it with what it started and,
  as only the app holds it, with the app however the app ends (`src/stack_windows.rs`).
- The server runs with its own folder as `HOME` and the app's `PATH`. The API and the worker are
  also told the person's own home folder and their login shell's `PATH` (`HOST_USER_HOME`,
  `HOST_USER_PATH`; the shell is asked once per start, for at most 5 s), which a command-line
  model provider the person installed and signed in to needs: with them, the server offers that
  tool as a model connection (`packages/adapters/src/cli-models/dozo-cli-*.ts`).
- Linux needs `libssl3` (Prisma's migration engine); without it the start says to install it.
  Postgres's Linux build carries a `libstdc++` that needs glibc 2.36; where it does not run
  (Ubuntu 22.04), the system's own is used instead (`fit_postgres` in `src/stack_setup.rs`).
- Sign-in with the hosted account (`HOSTED_LOGIN_ISSUER` on the server,
  `packages/auth/src/dozo-hosted-login.ts`) is off: a build or the environment turns it on with
  `DOZO_HOSTED_LOGIN_ISSUER`, the hosted origin (https, or http on this computer). A build that
  names it keeps it: the environment is read only by a build without one. The release workflow
  builds it from the repository variable of the same name, unset (off) by default. Without it the
  server opens with its own single account, as a self-hosted one does: its first page is the sign-up
  page, and the account made there is the only one it will ever have. With it, the local
  sign-in page's one button opens the hosted page that asks the person to agree in the app's own
  window, and its answer comes back to the local server's callback, which is the chosen server.
  Only while the chosen server is the one on this computer, and only that origin's
  `/dozo/hosted-login`, `/sign-in` and `/sign-up` load in the window (`src/server.rs`,
  `SIGN_IN_PATHS`); every other page of it, and a sign-in with another site (Google), goes to the
  browser as before, so such a sign-in cannot finish in the app. A move inside the hosted web app
  that loads no new page (its own routing) is not a navigation and stays in the window; those
  pages, like the server's, can call nothing in the app. A server that already has accounts of
  its own starts as before and keeps their password sign-in; each person links their account from
  Settings, and once every account is linked only the hosted sign-in is left
  (`packages/auth/src/dozo-hosted-login.ts`).
- Let Bots Use This Computer works against it: the end-to-end test pairs and connects.

### Updating the server

The app expects one server version (`SERVER_VERSION` in `src/stack.rs`, the one its manifest
names). When the installed one (`current`) is older, the next start updates it
(`src/stack_update.rs`); when it is the same, no manifest is read. The window says "Updating…"
in its one line.

1. With nothing running, the server's data (`pgdata/`, `data/`, `relay/`, `secrets`) is copied as
   files to `before-update/<old version>-<time>/` (this user only), and the `update` journal
   records it. A copy that cannot be made (a full disk) is dropped and the old version starts.
2. The new version is downloaded, checked and installed beside the old one in `versions/`, and
   only then made `current`. A download that fails starts the old version instead.
3. The server starts on it: the migrations run, then the health checks. Ready: the journal goes,
   two copies and two versions (the current and the one before) are kept.

If the new version does not start, the copy and the old version come back, and the window says
"The update did not start, so the server is back as it was." That version is not tried again on
its own (`update-skip`), until the app expects a newer one. An update cut off at any point (the app
killed, the disk full) is finished the same way at the next start, from the journal. A manifest
naming an older version than the installed one is never followed.

Why a file copy and not a `pg_dump`: the server is stopped, so the files are consistent; going
back is a rename; it needs no running Postgres of either version; and the secrets and the relay
keys come back with the database they belong to. Migrations cannot be undone, so going back is
always the copy.

### Back Up and Restore

Back Up… and Restore… in the Dozo menu are on while the server on this computer runs. They use the
bundle's own command (`dozo/server-bundle/README.md`, "Backup and restore"; `src/stack_backup.rs`)
from a small window (`ui/backup.html`, `src/backup.rs`):

- Back Up asks for a password twice ("Nobody can recover a lost password." is said once, there),
  then the system's save dialog picks the file (`Dozo <date>.dozobackup`). The running server is
  backed up as it is.
- Restore picks a file with the system's open dialog, then asks its password ("This replaces the
  data on this computer."). The command restores into an empty installation only, so the server
  stops and its data (`pgdata/`, `data/`, `relay/`, `secrets`) is moved aside into
  `before-restore/<time>/`; the backup goes into the emptied folder and the server starts on it.
  A restore that fails (a wrong password, a damaged file, a backup from a newer Dozo) puts the
  data back with renames and starts the server as it was ("… Nothing changed."); a restored
  server that does not start is swapped back the same way. The newest set moved aside is kept.
- The page sees a file's name, never its path: the path stays in the app. The password goes to
  the command's standard input only, never an argument, a variable or a log line.
- A bundle without the command (before 0.11.0-2) is told "Update the server first."
- Reset Password… (the same window) sets a new password for the account on this computer with
  the bundle's `account reset-password`, since a local server sends no email; the password is
  asked twice and goes to the command's standard input. Its sessions end, so the main window
  asks to sign in again. A computer that signs in with the hosted account has no password there
  and says so.
- Save Diagnostics… picks a file with the save dialog, writes the bundle's report there
  (`diagnostics --out`: versions, settings by name, recent log lines cleaned of secrets and of
  what people wrote) and shows it in the file manager; only a failure says anything.

### Connect Phone

The phone reaches the server on this computer through a relay, with no open port
(`dozo/relay/PROTOCOL.md`). The bundle carries the relay host agent as one file
(`dozo/relay/agent/README.md`); the app runs its `run` beside the server, under the same
supervision (restarts, logs in `logs/relay.log`, stopped with the server, ends with the app on
Linux), with its keys in `relay/`.

- Connect Phone… in the Dozo menu is on only while that server runs with the agent. It opens a
  small window: the QR code of a pairing offer (it works once, for ten minutes), the account the
  phone will sign in as ("Signs in as …", the email of the account signed in to the server in the
  main window; signed out, the window says to sign in first and shows no code), the time left,
  and the phones already paired, each with Remove. Once a phone scans the code, the same window
  asks "Connect this phone?" with the kind of phone (iPhone, Android) and the six-digit code it
  shows; Allow gives the phone its sign-in (the agent's `approve`) and closes the window, Reject
  removes it. The agent drops a pairing nobody allowed after 5 minutes (`expired`), and the window
  then says the code expired. The event and command are the agent's (`dozo/relay/agent/README.md`,
  Phone sign-in).
- The agent and the API share `DOZO_RELAY_AGENT_KEY`, made with the server's other secrets
  (`RELAY_AGENT_KEY` in `secrets`); `revoke` gets the server's `--origin`, so it ends the phone's
  session too.
- The relay is `https://relay.dozo.bot` unless the build (`DOZO_RELAY_URL`), the environment
  (`DOZO_RELAY_URL`) or a `relay=` line in the settings file names another (https, or http on
  this computer).
- The code is drawn by the page from the modules `qrcode` (Rust, no image features) computes.
- The window follows the system's light or dark appearance; the code is always dark on white.

Its folder is `local-server/` in the app's local data folder (`~/.local/share/dev.ssilistre.dozo/`,
`%LOCALAPPDATA%\dev.ssilistre.dozo\`, `~/Library/Application Support/dev.ssilistre.dozo/`):
`versions/<version>/` (node, postgres, server) and `current`, `pgdata/`, `data/` (the server's
files), `relay/` (the relay agent's keys), `secrets`, `ports`, `stack.lock`, `db-created`,
`downloads/`, `logs/`, `run/`, and for updates `before-update/`, `update` and `update-skip`. On macOS the local data folder is also the
config folder, where the settings file is `server`, so the two never share a name; a folder left
as `server/` by an earlier Linux or Windows build moves to `local-server/` once (one rename, and
only when `local-server/` is not there yet).

Tests: unit tests in each `src/stack*.rs` (stand-in processes for order, restarts and stops). The
end-to-end tests (`src/stack_e2e.rs`, ignored in a plain `cargo test`) need a bundle built by
`dozo/server-bundle/build.sh` and run without a window. `tests/stack_e2e_native.sh <dist>
<workspace>` runs them on Linux or macOS without Docker; the `Desktop stack e2e` jobs of
`dozo-server-bundle` run it on Ubuntu 22.04, the newest macOS on Apple silicon and macOS 15 on
Intel, with the bundle that run built, on every pull request that touches this directory, the
bundle or the relay code. Locally, in the Linux build image:

```sh
dozo/desktop/tests/stack_e2e.sh <dist> [<older dist>]   # last line DESKTOP STACK E2E: PASS|FAIL
```

1. Installs from a local manifest, gets 200 from `/health`, signs up, pairs and connects this
   computer, stops and finds no process left.
2. Starts from what is installed and kills the app with SIGKILL. On Linux nothing of the server
   outlives it; then the same with `PR_SET_PDEATHSIG` off, as on macOS, where the processes stay
   and the next start ends them before it starts.
3. Pairs a phone through the bundled agent against a dev relay (`tests/relay_phone.mts`): the
   phone fetches a page through the relay, both ends show the same code, the computer allows the
   phone and it signs in, then it is listed and removed. The test allows it the way the window's
   Allow button does, through the agent's `approve` (`phone::approve_phone`); the click itself is
   covered by the window tests under "Linux" (Xvfb), not here.
4. A server of its own in hosted sign-in mode signs in through a stand-in hosted server
   (`tests/fake_issuer.mjs`), each address on the way judged by the window's own rule. The real
   window against a real hosted server is `tests/hosted_login_window.sh <dozo-desktop binary>`
   (Linux, in Docker on Xvfb, driven through WebKit's WebDriver with tauri-driver; last line
   `HOSTED LOGIN WINDOW: PASS|FAIL`): a binary built with
   `DOZO_HOSTED_LOGIN_ISSUER=http://localhost:6173` opens a new computer's server, signs up on the
   hosted page, agrees and is signed in, in one window and with nothing handed to the browser,
   against the servers of `dozo/e2e/hosted-login` (`run.sh serve`). Run by hand, not in CI.
5. With an older server (`DOZO_STACK_E2E_OLD_MANIFEST`; CI uses the published `server-v0.11.0-1`,
   locally an older dist): installs it with an account, updates it to this bundle at the next
   start and the account still signs in; then a newer version whose Node is broken is put back and
   the server runs as it was, also at the start after that.
6. Backs that server up and restores it over newer data with the bundle's own command.

After each step no process of the server is left. The data folder is under a home whose path has a
space and non-ASCII letters. The verdict line is `DESKTOP STACK E2E (<os>): PASS|FAIL`, exit 2 on a
failure. Windows runs steps 1 to 4 with `tests/stack_e2e_windows.ps1` (below); no published
release has a Windows bundle yet to update from.

The relay canary (`dozo-relay-canary`, nightly and by hand, never on pull requests or forks) runs
steps 1 and 3 against the real relay with the server this app pins: `tests/stack_e2e_native.sh
--relay https://relay.dozo.bot <workspace>`. Whatever happens, every channel it made is revoked
afterwards (`tests/relay_revoke.sh`). A failure turns the run red and keeps the logs.

## Build

```sh
dozo/desktop/build.sh         # installs the toolchain if missing, builds, prints the paths
dozo/desktop/build.sh check   # cargo fmt --check, cargo clippy -D warnings, cargo test
```

A macOS app cannot be built in Docker, so this runs on the host (the exception is listed in
`dozo/AGENTS.md`). It needs the Xcode command line tools and installs nothing outside this
directory: rustup, Rust and the Tauri CLI go into `.toolchain/` and the build output into
`target/` (about 4 GB together; both git-ignored). The first run downloads and compiles for several minutes.
Versions are pinned in `rust-toolchain.toml`, `build.sh` (`TAURI_CLI`) and `Cargo.lock`.

Output: `dist/Dozo.app` and `dist/Dozo.dmg`, one universal app for Apple silicon and Intel Macs
(macOS 12 or later). The icon and the logo are generated from
`dozo/brand/assets/` at build time and are not committed here.

`make olc` does not run `check` (it runs in Docker and Rust is on the host): run it by hand after
changing anything in this directory. It checks the macOS code only; the Windows and Linux code is
compiled and tested by the workflows under "Windows" and "Linux".

## Windows

The same app, built on a GitHub Actions Windows runner: nothing here builds it on a Mac. It
compiles and packages there, and the unit tests pass there. Nobody has run the installed app on
Windows yet, so treat everything below as untested until someone does, except the server on this
computer, which CI runs end to end without a window.

- The server on this computer: `tests/stack_e2e_windows.ps1`, the `Desktop stack e2e windows` job
  of `dozo-server-bundle`, runs the app's own code against the Windows bundle that run built:
  install (Node and Postgres as a release serves them), start, `/health`, sign up, this
  computer's device socket, stop; a second start ended at once with the app (Task Manager's end);
  a phone paired through the relay agent (run, pair, approve, list, revoke); sign-in with the
  hosted account. After each, no process of the server is left. Long paths are turned off first,
  as Windows ships. Last line: `DESKTOP STACK E2E (windows): PASS|FAIL`.
- How it differs from Linux: there is no signal a process without a console hears, so a stop
  ends the Node processes at once (their job, with what they started); Postgres is started and
  stopped by `pg_ctl` (`stop -m fast`), which also gives up an administrator's rights that
  Postgres refuses to run with. Node for Windows is a zip. pnpm makes junctions on Windows, which
  an archive cannot carry: the Windows bundle lists its links (`dozo-links.json`) and the app
  makes them as junctions once the bundle is in its place. The secrets file is in
  `%LOCALAPPDATA%`, which only this user can read; it has no Unix mode.
- Not tried there: an installed app with a window, a user without administrator rights (the CI
  runner has them; `pg_ctl` and `initdb` give them up), SmartScreen and antivirus scanning the
  57,000 files of the bundle.

- Build: the `dozo-desktop-windows` workflow (`.github/workflows/dozo-desktop-windows.yml`). It
  runs on a pull request that touches this directory, or by hand from the Actions tab (Run
  workflow). It runs clippy and the tests, then `cargo tauri build`.
- Download: the run's `dozo-windows-installer` artifact, a zip holding `Dozo_<version>_x64-setup.exe`
  (an NSIS installer, for the signed-in user, no administrator rights). GitHub keeps artifacts
  for 90 days and asks for a GitHub sign-in to download one.
- Unsigned: Windows SmartScreen warns about an unknown publisher ("More info", then "Run
  anyway"). Handing it out needs a code signing certificate; see `dozo/LAUNCH-CHECKLIST.md`.
- WebView2: the app draws with Microsoft Edge WebView2, which Windows 11 has built in. Where it
  is missing (some Windows 10 installs), the installer downloads Microsoft's bootstrapper and
  installs it, so that computer needs an internet connection during setup.
- Differences from macOS (`tauri.windows.conf.json`, `#[cfg(windows)]` in `src/`): one short
  menu in the window (Settings… Ctrl+, / Change Server… / Reload Ctrl+R / Quit); the local screens are served
  from `http://tauri.localhost`; `src/frames.rs` is not needed, because the web view asks the
  navigation hook about the window's own page only; links open through the system's URL handler.
  The server address and window position are kept in `%APPDATA%\dev.ssilistre.dozo\`, the web
  view's data in `%LOCALAPPDATA%\dev.ssilistre.dozo\`.
- x64 only.

## Linux

The same app as an AppImage and a .deb for x86_64, built in Docker on any Linux machine and by
the `dozo-desktop-linux` workflow (`.github/workflows/dozo-desktop-linux.yml`, on a pull request
that touches this directory or by hand). Both build on Ubuntu 22.04, so they run on that
release's libraries and newer.

```sh
dozo/desktop/build-linux.sh         # dist/Dozo_<version>_amd64.AppImage and .deb
dozo/desktop/build-linux.sh check   # cargo fmt --check, clippy, cargo test
```

- The AppImage runs where it is (`chmod +x`, then open it). It brings its own libraries except
  the system's GTK and WebKitGTK stack. The .deb installs with `sudo apt install ./Dozo_*.deb`
  and requires `libwebkit2gtk-4.1-0` 2.40 or later; the AppImage needs that too.
- `tests/linux_gate.py` (run by the workflow under a virtual display) checks that a frame from
  another site loads, a clicked link to it opens in the browser without the app requesting it, a
  frame cannot open a mail link on its own, a page sent elsewhere by its script stays, a second
  launch shows the first window, and closing the window ends the app, or with Keep Running in
  Background and no tray keeps it minimized. It also checks that the server's page gets
  notifications and a frame from another origin does not, that one reaches a stand-in for the
  desktop's notification service (`tests/fake_notifications.py`), that a click on it brings the
  window back, and that titles with and without a count leave the app running. Nobody has run the
  app on a desktop session yet.
- Differences from macOS (`tauri.linux.conf.json`, `#[cfg(target_os = "linux")]` in `src/`): the
  short menu Windows has, inside the window; links open with `xdg-open`; the frame gate above.
  The server address and window position are kept in `~/.config/dev.ssilistre.dozo/`, the web
  view's data in `~/.local/share/dev.ssilistre.dozo/`.
- Unsigned. A Linux package needs no signature to open.

## Signing and distribution

With `~/.config/dozo/sign.conf` in place (`sign.conf.example` lists its two values), `build.sh`
signs the app and the disk image with a Developer ID, has Apple notarize both, staples the tickets
and asks Gatekeeper about each; it fails if any step does, or if the file lacks a value. Such a build opens on any Mac
without a warning. The identity and the notary credentials stay in the keychain of the Mac that
builds: nothing about them is in this repository, and CI does not sign.

- Hardened runtime, secure timestamp.
- Entitlements: the microphone only (`Entitlements.plist`, `com.apple.security.device.audio-input`),
  which the hardened runtime needs before the system asks the person about it. The app does not
  use the App Sandbox. It runs no JIT and loads no unsigned code: the system web view compiles
  JavaScript in its own processes, which carry Apple's entitlements. Camera requests are denied,
  so there is no camera entitlement.

Without that file the app is signed ad hoc and `build.sh` says so. It then opens without a warning
only on the Mac that built it; a downloaded copy is blocked by Gatekeeper.

## Updates

- At launch and then once a day the app reads
  `https://github.com/SSilistre-dev/dozo/releases/latest/download/latest.json`, downloads a newer
  version in the background and keeps it only if its signature checks out against the public key
  in `tauri.conf.json` and was made for the version the manifest names (`requireSignedVersion`).
- Then one menu appears at the end of the menu bar, "Restart to Update" ("Güncellemek için yeniden
  başlat" on a Turkish system), holding that one item. Nothing installs until it is picked. On
  Windows the installer closes the app and opens the new one; on macOS and Linux the app restarts.
  If the install fails, the update stays waiting and the menu can be picked again.
- A failed check, download, signature or install changes nothing and adds a line to `updates.log`
  (cut to a fresh file past 64 KB, keeping one older file) in the app's log folder (`~/Library/Logs/dev.ssilistre.dozo/`,
  `%LOCALAPPDATA%\dev.ssilistre.dozo\logs\`, `~/.local/share/dev.ssilistre.dozo/logs/`).
- Linux: the AppImage replaces itself, so its folder must be writable; the .deb asks for an
  administrator password through the system's prompt.
- Release: push a `desktop-v<version>` tag on a commit already on `main`, whose version matches
  `tauri.conf.json` and `Cargo.toml`; the workflow stops otherwise. The `dozo-desktop-release`
  workflow builds all three systems in the `desktop-release` environment, signs every update
  package with the updater key (secrets `TAURI_SIGNING_PRIVATE_KEY` and
  `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`, given only to the steps that sign), writes `latest.json`
  (`latest-json.sh`) and checksums, and leaves a draft release.
- Publish the draft as the repository's latest release (`gh release edit <tag> --draft=false
  --latest`): the apps read `releases/latest`, so if any other release became the latest, every
  app would find no manifest and stop updating until a desktop release is latest again.
- The private key and its password are kept only in those secrets and offline by the owner:
  without them no installed app can be updated again.
- Platform signing in that workflow is optional. With `APPLE_CERTIFICATE`,
  `APPLE_CERTIFICATE_PASSWORD` and `APPLE_SIGNING_IDENTITY` the Mac app is signed, and with
  `APPLE_ID`, `APPLE_PASSWORD` and `APPLE_TEAM_ID` also notarized; with `WINDOWS_CERTIFICATE` (a
  base64 .pfx) and `WINDOWS_CERTIFICATE_PASSWORD` the Windows installer is signed. Without them
  the packages are built unsigned (the Mac app ad hoc) and the run still succeeds: an ad-hoc Mac
  disk image is blocked by Gatekeeper when downloaded, so replace it in the draft with one from
  `build.sh` until the Apple secrets are set. Its disk image is not signed itself either way.

## Where it keeps things

- `~/Library/Application Support/dev.ssilistre.dozo/`: the server address, the two switches and the
  window position; under `devices/`, per server, the account this computer is allowed for and
  whether a revoke is pending (Windows and Linux: the config folders named above). The device
  token is in the system keyring under `dev.ssilistre.dozo`. Each bot's own folder is under
  `computers/` in the app's data folder (the same folder on macOS, `~/.local/share/dev.ssilistre.dozo/` on Linux).
- `local-server/` in the app's local data folder: the server on this computer, installed and with its
  database ("The server on this computer").
- `~/Library/WebKit/dev.ssilistre.dozo/` and `~/Library/HTTPStorages/dev.ssilistre.dozo.binarycookies`:
  the web view's site data and cookies.
