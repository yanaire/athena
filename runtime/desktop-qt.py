"""Scoped mailbox for an application that embeds Qt and can load an Athena bridge."""
import ctypes
import json
import os
import pathlib
import time
import uuid

try:
    from PySide6 import QtCore, QtGui, QtWidgets
except ImportError:
    from PySide2 import QtCore, QtGui, QtWidgets


class BridgeError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status


def _parent_alive(pid):
    if os.name != "nt":
        return lambda: os.getppid() == pid
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.OpenProcess.restype = ctypes.c_void_p
    kernel.WaitForSingleObject.argtypes = [ctypes.c_void_p, ctypes.c_ulong]
    handle = kernel.OpenProcess(0x00100000, False, pid)
    return lambda: bool(handle) and kernel.WaitForSingleObject(handle, 0) == 258


def _write_json(path, value):
    scratch = path.with_name("." + uuid.uuid4().hex)
    try:
        with scratch.open("x", encoding="utf-8") as file:
            json.dump(value, file, allow_nan=False)
        os.replace(scratch, path)
    finally:
        scratch.unlink(missing_ok=True)


class WindowBridge:
    def __init__(self, directory, app_id, main_window, document_identity, actions):
        self.directory = pathlib.Path(directory)
        self.app_id = app_id
        self.main = main_window
        self.document_identity = document_identity
        self.actions = actions
        self.parent_alive = _parent_alive(int(os.environ["ATHENA_DESKTOP_PARENT"]))
        self.observed = None
        self.timer = QtCore.QTimer(self.main)
        self.timer.timeout.connect(self._poll)
        self.timer.start(40)

    def _live(self):
        return self.parent_alive() and not (self.directory / "revoked").exists()

    def _window(self):
        app = QtWidgets.QApplication
        window = app.activePopupWidget() or app.activeModalWidget() or self.main
        ancestor = window
        while ancestor is not None and ancestor != self.main:
            ancestor = ancestor.parentWidget()
        if ancestor != self.main or not window.isVisible() or window.isMinimized():
            raise BridgeError("stale_observation", "The approved app window is unavailable.")
        handle = window.windowHandle()
        screen = handle.screen() if handle else None
        if screen is None:
            raise BridgeError("stale_observation", "The app window has no active screen.")
        bounds = window.geometry()
        origin = window.mapToGlobal(QtCore.QPoint(0, 0))
        identity = {
            "appId": self.app_id,
            "pid": os.getpid(),
            "windowId": str(int(window.winId())),
            "document": self.document_identity(),
            "viewport": [origin.x(), origin.y(), bounds.width(), bounds.height(),
                         window.devicePixelRatioF(), screen.logicalDotsPerInchX(), screen.logicalDotsPerInchY()],
        }
        return window, identity

    def _poll(self):
        if not self._live():
            self.observed = None
            self.timer.stop()
            return
        path = self.directory / "request.json"
        try:
            request = json.loads(path.read_text(encoding="utf-8"))
            path.unlink(missing_ok=True)
        except FileNotFoundError:
            return
        request_id = str(uuid.UUID(request["id"]))
        status = {"id": request_id, "status": "ok"}
        dispatched = False
        self.timer.stop()
        try:
            window, identity = self._window()
            actions = self.actions(window)
            if not self._live() or time.time() * 1000 >= request["deadline"]:
                raise BridgeError("stopped", "The app input request expired or was revoked.")
            if request["kind"] == "observe":
                capture = window.grab()
                if capture.isNull() or capture.width() > 4096 or capture.height() > 4096:
                    raise BridgeError("failed", "The approved app window could not be captured.")
                if not capture.save(str(self.directory / (request_id + ".png")), "PNG"):
                    raise BridgeError("failed", "The approved window capture could not be encoded.")
                self.observed = (identity, tuple(actions))
                status.update(window=identity, targets=list(actions))
            elif request["kind"] == "activate":
                observed, self.observed = self.observed, None
                if observed != (identity, tuple(actions)) or request["window"] != identity or request["target"] not in actions:
                    raise BridgeError("stale_observation", "The window, document, scale or displayed controls changed. Observe again.")
                if not self._live():
                    raise BridgeError("stopped", "The user took over the app.")
                dispatched = True
                actions[request["target"]]()
            else:
                raise BridgeError("unsupported", "Unknown app bridge operation.")
        except BridgeError as error:
            status.update(status=error.status, message=str(error))
        except PermissionError:
            status.update(status="indeterminate" if dispatched else "denied", message="The app bridge could not access its scoped files.")
        except Exception:
            status.update(status="indeterminate" if dispatched else "failed", message="The app bridge could not complete the operation.")
        finally:
            if self._live():
                _write_json(self.directory / "reply.json", status)
                self.timer.start(40)
