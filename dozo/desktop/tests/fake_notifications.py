"""A stand-in for the desktop's notification service (org.freedesktop.Notifications) on the session bus.

Usage: python3 tests/fake_notifications.py <directory>
Writes one line per notification shown to <directory>/shown ("<id> <summary>"). When a file
<directory>/click appears holding an id, it says that notification was clicked, as a desktop does,
and removes the file. Writes <directory>/ready once it owns the name. Needs python3-gi.
"""

import pathlib
import sys

from gi.repository import Gio, GLib

XML = """<node><interface name="org.freedesktop.Notifications">
<method name="GetCapabilities"><arg type="as" direction="out"/></method>
<method name="GetServerInformation"><arg type="s" direction="out"/><arg type="s" direction="out"/>
<arg type="s" direction="out"/><arg type="s" direction="out"/></method>
<method name="Notify"><arg type="s"/><arg type="u"/><arg type="s"/><arg type="s"/><arg type="s"/>
<arg type="as"/><arg type="a{sv}"/><arg type="i"/><arg type="u" direction="out"/></method>
<method name="CloseNotification"><arg type="u"/></method>
<signal name="ActionInvoked"><arg type="u"/><arg type="s"/></signal>
<signal name="NotificationClosed"><arg type="u"/><arg type="u"/></signal>
</interface></node>"""
PATH = "/org/freedesktop/Notifications"
NAME = "org.freedesktop.Notifications"

out = pathlib.Path(sys.argv[1])
state = {"next": 1, "bus": None}


def call(connection, sender, path, interface, method, params, invocation):
    if method == "GetCapabilities":
        invocation.return_value(GLib.Variant("(as)", (["actions", "body"],)))
    elif method == "GetServerInformation":
        invocation.return_value(GLib.Variant("(ssss)", ("fake", "gate", "1", "1.2")))
    elif method == "Notify":
        ident = state["next"]
        state["next"] += 1
        with (out / "shown").open("a") as shown:
            shown.write(f"{ident} {params.unpack()[3]}\n")
        invocation.return_value(GLib.Variant("(u)", (ident,)))
    else:
        invocation.return_value(None)


def poll_click():
    click = out / "click"
    if click.exists():
        ident = int(click.read_text().strip())
        click.unlink()
        state["bus"].emit_signal(None, PATH, NAME, "ActionInvoked", GLib.Variant("(us)", (ident, "default")))
    return True


def acquired(connection, name):
    (out / "ready").write_text("")


def bus_up(connection, name):
    state["bus"] = connection
    connection.register_object(PATH, Gio.DBusNodeInfo.new_for_xml(XML).interfaces[0], call, None, None)


Gio.bus_own_name(Gio.BusType.SESSION, NAME, Gio.BusNameOwnerFlags.NONE, bus_up, acquired, None)
GLib.timeout_add(100, poll_click)
GLib.MainLoop().run()
