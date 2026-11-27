# FreeCAD automation

Open a project conversation and select **FreeCAD** below the composer. The panel shows the app, project, model and project CAD directory. Enter an output stem and millimetre dimensions for a rectangular block with a centered through-hole. Select an Athena-generated FCStd from the conversation to edit its parametric block and hole in a new output. Each attempt writes into its own directory under the project CAD directory.

Athena mounts the FreeCAD tool only for a run authorized from this panel. The tool accepts no model-provided paths, scripts or arguments. The native adapter saves an FCStd and exports a STEP using FreeCAD's own Python API. A separate FreeCAD process opens the FCStd and reads the STEP. It checks the STEP length-unit declaration, bounding box, cylindrical face and hole depth, closed solid validity, and volume. The host compares the output bytes before and after the check, then publishes both files and `freecad-verification.json` in Artifacts. The Workflow DAG and tool log link the same run and receipt.

The host discovers a standard FreeCAD installation. For another installed location, set `ATHENA_FREECAD_APP` to its absolute GUI executable path. A matching Python host and FreeCAD module directory can be supplied together through `ATHENA_FREECAD_PYTHON` and `ATHENA_FREECAD_MODULES`. The Debian FreeCAD Python package is detected automatically. Other desktop installations can run the fixed API worker in a separate FreeCAD process with private configuration.

## Verification

On Linux with FreeCAD 1.0.0, a controlled loopback provider caused the real Pi tool call to run the real FreeCAD API. The run produced and reopened `test_part.FCStd` and `test_part.step`. Both contained one closed, valid 40 × 20 × 10 mm solid with a centered 6 mm through-hole and a volume of 7717.256661 mm³. An edit increased the width to 24 mm and preserved the original artifact bytes after a host restart.

```sh
ATHENA_TEST_FREECAD=api node --test tests/freecad-acceptance.test.ts
```

The provider in that test is a controlled response fixture. Native macOS and Windows desktop automation are **NOT RUN** in the Linux workspace. Native package builds have their own CI checks.
