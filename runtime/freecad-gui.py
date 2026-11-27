"""Operate FreeCAD's visible Part workbench, tree and save/export dialogs."""
import importlib.util
import json
import os
import pathlib
import sqlite3

import FreeCAD as App
import FreeCADGui as Gui


def _bridge_module():
    module = importlib.util.spec_from_file_location("athena_desktop_qt", os.environ["ATHENA_FREECAD_QT_BRIDGE"])
    bridge = importlib.util.module_from_spec(module)
    module.loader.exec_module(bridge)
    return bridge


desktop = _bridge_module()
QtCore, QtGui, QtWidgets = desktop.QtCore, desktop.QtGui, desktop.QtWidgets
Qt = QtCore.Qt
QAction = getattr(QtGui, "QAction", None) or QtWidgets.QAction
BridgeError = desktop.BridgeError


class FreeCADControls:
    def __init__(self, main, workspace, spec, directory):
        self.main = main
        self.workspace = workspace
        self.spec = spec
        self.directory = directory
        self.native = workspace / (spec["name"] + ".FCStd")
        self.step = workspace / (spec["name"] + ".step")
        self.stage = "new_document"
        self.document_name = None
        self.bridge = None

    def document_identity(self):
        doc = App.ActiveDocument
        if doc is None:
            return None
        return json.dumps([doc.Name, doc.Label, doc.FileName, [obj.Name for obj in doc.Objects],
                           list(doc.getUndoNames()) if hasattr(doc, "getUndoNames") else []])

    def capture_surface(self, widget, kind, width, height):
        # FreeCAD's Coin3D viewport can use its own buffer. Render the current
        # view into the scoped screenshot through FreeCAD's image API.
        if kind != "Gui::View3DInventorViewer" or self.stage not in ("finish_export", "wait_for_files") or not self.step.is_file():
            return widget.grabFramebuffer()
        view = Gui.activeDocument()
        if view is None:
            raise BridgeError("stale_observation", "The FreeCAD model viewport is unavailable.")
        path = self.directory / "viewport.png"
        try:
            view.activeView().saveImage(str(path), width, height, "Current")
            return QtGui.QImage(str(path))
        finally:
            path.unlink(missing_ok=True)

    def _action(self, name):
        item = self.main.findChild(QAction, name)
        return item if item and item.isEnabled() and item.isVisible() else None

    def _next(self, title, callback, next_stage):
        def activate():
            callback()
            self.stage = next_stage
        return {title: activate}

    def _command(self, name, next_stage, queued=False):
        action = self._action(name)
        if action:
            callback = (lambda: self.bridge.queue_native_slot(action, "trigger")) if queued else action.trigger
            return self._next(self.stage, callback, next_stage)
        return {}

    def _visible(self, kind, name):
        widget = self.main.findChild(kind, name)
        return widget if widget and widget.isVisible() and widget.isEnabled() else None

    def _button(self, window, label):
        buttons = [button for button in window.findChildren(QtWidgets.QPushButton)
                   if button.isVisible() and button.isEnabled() and button.text().replace("&", "") == label]
        return buttons[0] if len(buttons) == 1 else None

    def _primitive(self, label, next_stage):
        combo = self._visible(QtWidgets.QComboBox, "PrimitiveTypeCB")
        index = combo.findText(label) if combo else -1
        if index < 0:
            return {}

        def choose():
            combo.setCurrentIndex(index)
            combo.activated.emit(index)
        return self._next(self.stage, choose, next_stage)

    def _quantity(self, name, value):
        spin = self._visible(QtWidgets.QAbstractSpinBox, name)
        edit = spin.findChild(QtWidgets.QLineEdit) if spin else None
        if not edit:
            raise BridgeError("stale_observation", "The FreeCAD dimension field is unavailable.")
        edit.setText(format(value, ".10g") + " mm")
        if not edit.hasAcceptableInput():
            raise BridgeError("failed", "The FreeCAD dimension field rejected the approved value.")
        spin.editingFinished.emit()
        if abs(float(spin.property("rawValue")) - value) > 0.00001:
            raise BridgeError("failed", "The FreeCAD dimension field did not retain the approved value.")

    def _create_primitive(self, fields, next_stage):
        box = self.main.findChild(QtWidgets.QWidget, "PartGui__DlgPrimitives")
        button = self._button(self.main, "Create")
        if not box or not box.isVisible() or not button or any(
                not self._visible(QtWidgets.QAbstractSpinBox, field) for field in fields):
            return {}

        def create():
            for name, value in fields.items():
                self._quantity(name, value)
            button.click()
        return self._next(self.stage, create, next_stage)

    def _select(self, labels, next_stage):
        trees = [tree for tree in self.main.findChildren(QtWidgets.QTreeWidget)
                 if tree.isVisible() and tree.metaObject().className() == "Gui::TreeWidget"]
        if len(trees) != 1:
            return {}
        tree = trees[0]
        rows = [tree.findItems(label, Qt.MatchExactly | Qt.MatchRecursive) for label in labels]
        if any(len(row) != 1 for row in rows):
            return {}

        def select():
            tree.clearSelection()
            for row in rows:
                row[0].setSelected(True)
        return self._next(self.stage, select, next_stage)

    def _save(self, window, path, extension, next_stage):
        if not isinstance(window, QtWidgets.QFileDialog):
            return {}
        filters = [item for item in window.nameFilters() if "*." + extension in item.lower()]
        name = window.findChild(QtWidgets.QLineEdit, "fileNameEdit")
        if len(filters) != 1 or not name or not name.isVisible() or not name.isEnabled():
            return {}

        def accept():
            if path.exists():
                raise BridgeError("indeterminate", "The new output path is already occupied.")
            window.setDirectory(str(path.parent))
            window.selectNameFilter(filters[0])
            name.setText(path.name)
            if [os.path.normcase(value) for value in window.selectedFiles()] != [os.path.normcase(str(path))]:
                raise BridgeError("denied", "The file dialog did not select the approved path.")
            self.bridge.queue_native_slot(window, "accept")
        return self._next(self.stage, accept, next_stage)

    def actions(self, window):
        doc = App.ActiveDocument
        if self.stage == "new_document":
            if window != self.main or App.listDocuments():
                return {}
            action = self._action("Std_New")
            if not action:
                return {}

            def create():
                action.trigger()
                if App.ActiveDocument is None or len(App.listDocuments()) != 1:
                    raise BridgeError("failed", "FreeCAD did not open the approved new document.")
                self.document_name = App.ActiveDocument.Name
            return self._next(self.stage, create, "part_workbench")
        if doc is None or doc.Name != self.document_name or len(App.listDocuments()) != 1:
            return {}
        if self.stage == "save_native":
            return self._save(window, self.native, "fcstd", "select_result")
        if self.stage == "save_step":
            return self._save(window, self.step, "step", "finish_export")
        if self.stage == "finish_export":
            if window == self.main:
                return {"complete": lambda: None} if self.native.is_file() and self.step.is_file() else {}
            button = self._button(window, "OK")
            if "step" in window.windowTitle().lower() and button:
                return self._next("confirm_step_options", button.click, "wait_for_files")
            return {}
        if window != self.main:
            return {}
        if self.stage == "wait_for_files":
            return {"complete": lambda: None} if self.native.is_file() and self.step.is_file() else {}
        if self.stage == "part_workbench":
            return self._next(self.stage, lambda: Gui.activateWorkbench("PartWorkbench"), "open_primitives")
        if self.stage == "open_primitives":
            return self._command("Part_Primitives", "choose_box")
        if self.stage == "choose_box":
            return self._primitive("Box", "create_box")
        if self.stage == "create_box":
            return self._create_primitive({"boxLength": self.spec["length"], "boxWidth": self.spec["width"],
                                           "boxHeight": self.spec["height"]}, "choose_cylinder")
        if self.stage == "choose_cylinder":
            return self._primitive("Cylinder", "create_cylinder")
        if self.stage == "create_cylinder":
            gap = min(1, self.spec["height"])
            return self._create_primitive({"cylinderRadius": self.spec["diameter"] / 2,
                                           "cylinderHeight": self.spec["height"] + 2 * gap,
                                           "XPositionQSB": self.spec["length"] / 2, "YPositionQSB": self.spec["width"] / 2,
                                           "ZPositionQSB": -gap}, "close_primitives")
        if self.stage == "close_primitives":
            button = self._button(self.main, "Close")
            return self._next(self.stage, button.click, "select_operands") if button else {}
        if self.stage == "select_operands":
            return self._select(("Box", "Cylinder"), "cut")
        if self.stage == "cut":
            return self._command("Part_Cut", "fit_view")
        if self.stage == "fit_view":
            return self._command("Std_ViewFitAll", "open_save")
        if self.stage == "open_save":
            return self._command("Std_SaveAs", "save_native", queued=True)
        if self.stage == "select_result" and os.path.normcase(doc.FileName) == os.path.normcase(str(self.native)):
            return self._select(("Cut",), "open_export")
        if self.stage == "open_export":
            return self._command("Std_Export", "save_step", queued=True)
        return {}


def attach():
    directory = pathlib.Path(os.environ["ATHENA_FREECAD_GUI_DIRECTORY"])
    if (directory / "owner").read_text(encoding="ascii") != str(os.getpid()):
        return
    if (directory / "revoked").exists():
        return
    request = json.loads((directory / "request-scope.json").read_text(encoding="utf-8"))
    writer = request["writer"]
    db = sqlite3.connect(pathlib.Path(writer["lock"]).as_uri() + "?mode=rw", timeout=0, uri=True)
    try:
        db.execute("BEGIN EXCLUSIVE")
        with open(writer["marker"], encoding="utf-8") as file:
            if json.load(file)["attemptId"] != writer["attemptId"]:
                raise BridgeError("denied", "The FreeCAD window write grant is inactive.")
        _attach_window(directory, request, db)
    except Exception:
        db.close()
        raise


def _attach_window(directory, request, writer_lock):
    QtWidgets.QApplication.setAttribute(Qt.AA_DontUseNativeDialogs)
    main = Gui.getMainWindow()
    controls = FreeCADControls(main, pathlib.Path(request["workspace"]), request["spec"], directory)
    controls.bridge = desktop.WindowBridge(directory, "freecad", main, controls.document_identity,
                                           controls.actions, writer_lock.close, controls.capture_surface)
    main._athena_controls = controls
    desktop._write_json(directory / "ready.json", {"pid": os.getpid(), "version": ".".join(App.Version()[:3])})


attach()
