"""FreeCAD's native API for a bounded parametric block and through-hole."""
import json
import math
import os
import pathlib
import re
import sqlite3
import sys


def _geometry(spec):
    length, width, height, diameter = (spec[key] for key in ("length", "width", "height", "diameter"))
    return length, width, height, diameter / 2


def _normal_part(doc, app, spec, editing):
    if editing:
        stock, hole, result = [doc.getObject(name) for name in ("AthenaStock", "AthenaHole", "AthenaResult")]
        if (not all((stock, hole, result)) or
                (stock.TypeId, hole.TypeId, result.TypeId) != ("Part::Box", "Part::Cylinder", "Part::Cut") or
                result.Base != stock or result.Tool != hole or len(doc.Objects) != 3):
            return None
    else:
        stock = doc.addObject("Part::Box", "AthenaStock")
        hole = doc.addObject("Part::Cylinder", "AthenaHole")
        result = doc.addObject("Part::Cut", "AthenaResult")
        result.Base, result.Tool = stock, hole
    length, width, height, radius = _geometry(spec)
    stock.Length, stock.Width, stock.Height = length, width, height
    stock.Placement = app.Placement()
    stock.Label = "Stock"
    gap = min(1, height)
    hole.Radius, hole.Height, hole.Angle = radius, height + 2 * gap, 360
    hole.Placement = app.Placement(app.Vector(length / 2, width / 2, -gap), app.Rotation())
    hole.Label = "Through hole"
    result.Label = spec["name"]
    doc.Label = spec["name"]
    doc.recompute()
    if app.GuiUp:
        stock.Visibility = hole.Visibility = False
    if result.Shape.isNull() or not result.Shape.isValid():
        raise ValueError("The FreeCAD boolean operation did not produce a valid shape.")
    return result


def _author(app, part, workspace, spec):
    original = workspace / ".athena-source.FCStd"
    editing = original.is_file()
    doc = app.openDocument(str(original)) if editing else app.newDocument("AthenaPart")
    try:
        result = _normal_part(doc, app, spec, editing)
        if result is None:
            return {"status": "unsupported", "message": "The source is not an Athena parametric FreeCAD part."}
        native, step = _paths(workspace, spec)
        if native.exists() or step.exists():
            raise ValueError("The new FreeCAD output location is occupied.")
        doc.saveAs(str(native))
        part.export([result], str(step))
        return {"status": "ok"}
    finally:
        app.closeDocument(doc.Name)


def _locked_author(app, part, workspace, spec, writer):
    if writer is None:
        return _author(app, part, workspace, spec)
    uri = pathlib.Path(writer["lock"]).as_uri() + "?mode=rw"
    db = sqlite3.connect(uri, timeout=0, uri=True)
    try:
        db.execute("BEGIN EXCLUSIVE")
        with open(writer["marker"], encoding="utf-8") as file:
            if json.load(file)["attemptId"] != writer["attemptId"]:
                return {"status": "denied", "message": "The FreeCAD write grant is inactive."}
        return _author(app, part, workspace, spec)
    finally:
        db.close()


def _paths(workspace, spec):
    return (workspace / (spec["name"] + ".FCStd"), workspace / (spec["name"] + ".step"))


def _step_units(path):
    source = path.read_text(encoding="ascii", errors="replace")
    # The direct FreeCAD exporter declares physical length units independently
    # of OCC's conversion to internal millimetres when the file is reopened.
    assignments = re.findall(r"GLOBAL_UNIT_ASSIGNED_CONTEXT\s*\(\(([^()]+)\)\)", source)
    records = dict(re.findall(r"#(\d+)\s*=\s*(.*?);", source, flags=re.S))
    if not assignments:
        raise ValueError("The STEP file has no declared length units.")
    length_units = re.compile(r"SI_UNIT\s*\(\s*\.MILLI\.\s*,\s*\.METRE\.\s*\)")
    for assignment in assignments:
        length = [records.get(ref, "") for ref in re.findall(r"#(\d+)", assignment)
                  if "LENGTH_UNIT" in records.get(ref, "")]
        if len(length) != 1 or not length_units.search(length[0]):
            raise ValueError("The STEP geometry is not explicitly declared in millimetres.")
    return "mm"


def _inspect(app, part, shape, units, spec):
    if shape.isNull() or not shape.isValid() or not shape.isClosed() or len(shape.Solids) != 1:
        raise ValueError("A reopened file did not contain one closed, valid solid.")
    solid = shape.Solids[0]
    length, width, height, radius = _geometry(spec)
    bounds = solid.BoundBox
    dimensions = [bounds.XLength, bounds.YLength, bounds.ZLength]
    close = lambda a, b: math.isclose(a, b, rel_tol=0, abs_tol=0.0001)
    if not all(close(a, b) for a, b in zip(dimensions, (length, width, height))):
        raise ValueError("A reopened file has unexpected external dimensions.")
    x, y = bounds.XMin + length / 2, bounds.YMin + width / 2
    holes = []
    for face in solid.Faces:
        surface = face.Surface
        if not isinstance(surface, part.Cylinder):
            continue
        if (close(x, surface.Center.x) and close(y, surface.Center.y) and close(radius, surface.Radius)
                and close(abs(surface.Axis.z), 1) and close(bounds.ZMin, face.BoundBox.ZMin)
                and close(bounds.ZMax, face.BoundBox.ZMax)):
            holes.append(surface)
    if len(holes) != 1 or any(solid.isInside(app.Vector(x, y, bounds.ZMin + height * f), 1e-6, False)
                             for f in (0.1, 0.5, 0.9)):
        raise ValueError("A reopened file is missing the specified central through-hole.")
    expected = length * width * height - math.pi * radius * radius * height
    if not math.isclose(solid.Volume, expected, abs_tol=0.001, rel_tol=1e-9):
        raise ValueError("A reopened file has unexpected solid volume.")
    return {"units": units, "dimensionsMm": dimensions, "throughHole": {
        "diameterMm": 2 * holes[0].Radius, "centerMm": [x - bounds.XMin, y - bounds.YMin],
        "depthMm": bounds.ZLength}, "closed": True, "valid": True, "solids": 1,
        "volumeMm3": solid.Volume, "expectedVolumeMm3": expected}


def _verify(app, part, workspace, spec):
    native, step = _paths(workspace, spec)
    doc = app.openDocument(str(native))
    try:
        roots = [obj.Shape for obj in doc.RootObjects if hasattr(obj, "Shape") and not obj.Shape.isNull()]
        if len(roots) != 1:
            raise ValueError("The native FreeCAD document has an unexpected shape hierarchy.")
        if app.Units.Quantity("1 mm").Value != 1:
            raise ValueError("The FreeCAD API did not use internal millimetres.")
        native_result = _inspect(app, part, roots[0], "mm", spec)
    finally:
        app.closeDocument(doc.Name)
    return {"status": "ok", "files": {native.name: native_result,
                                      step.name: _inspect(app, part, part.read(str(step)), _step_units(step), spec)}}


def main():
    request_path = pathlib.Path(os.environ["ATHENA_FREECAD_REQUEST"])
    with request_path.open(encoding="utf-8") as file:
        request = json.load(file)
    if request.get("modules"):
        sys.path.insert(0, request["modules"])
    workspace = pathlib.Path(request["workspace"])
    mode = request["mode"]
    try:
        import FreeCAD as app
        import Part as part
    except (ImportError, OSError):
        return {"status": "unsupported", "message": "The approved process could not load the FreeCAD Python API."}
    try:
        if mode == "author":
            output = _locked_author(app, part, workspace, request["spec"], request.get("writer"))
        elif mode == "verify":
            output = _verify(app, part, workspace, request["spec"])
        else:
            raise ValueError("Unregistered FreeCAD API operation.")
        return dict(output, version=".".join(app.Version()[:3]))
    except PermissionError:
        return {"status": "denied", "message": "FreeCAD could not access a scoped file."}
    except Exception as error:
        status = "indeterminate" if mode == "author" else "invalid_result" if isinstance(error, ValueError) else "failed"
        return {"status": status,
                "message": str(error).splitlines()[0][:400] if isinstance(error, ValueError) else "FreeCAD could not complete the scoped operation."}


if __name__ == "__main__":
    # On platforms without a standalone FreeCAD Python host this file runs in
    # the Athena-owned FreeCAD app, via a fixed bootstrap macro.
    owner = os.environ.get("ATHENA_FREECAD_OWNER_FILE")
    if not owner or pathlib.Path(owner).read_text(encoding="ascii") == str(os.getpid()):
        output = "ATHENA_CAD_RESULT " + json.dumps(main(), allow_nan=False) + "\n"
        os.write(1, output.encode("utf-8"))
        if owner:
            os._exit(0)
