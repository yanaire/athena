# FreeCAD automation

Open a project conversation and select **FreeCAD** below the composer. The panel shows the app, project, model and project CAD directory. Enter an output stem and millimetre dimensions for a rectangular block with a centered through-hole. Select an Athena-generated FCStd from the conversation to edit its parametric block and hole in a new output. Each attempt writes into its own directory under the project CAD directory.

Athena mounts the FreeCAD tool only for a run authorized from this panel. The tool accepts no model-provided paths, scripts or arguments. The native adapter saves an FCStd and exports a STEP using FreeCAD's own Python API. A separate FreeCAD process opens the FCStd and reads the STEP. It checks the STEP length-unit declaration, bounding box, cylindrical face and hole depth, closed solid validity, and volume. The host compares the output bytes before and after the check, then publishes both files and `freecad-verification.json` in Artifacts. The Workflow DAG and tool log link the same run and receipt.

The host discovers a standard FreeCAD installation. For another installed location, set `ATHENA_FREECAD_APP` to its absolute GUI executable path. A matching Python host and FreeCAD module directory can be supplied together through `ATHENA_FREECAD_PYTHON` and `ATHENA_FREECAD_MODULES`. The Debian FreeCAD Python package is detected automatically. Other desktop installations can run the fixed API worker in a separate FreeCAD process with private configuration.

## FreeCAD window control

The optional **Allow FreeCAD window control and image sharing** setting applies to one run. When API authoring reports unsupported, Athena sends a synthetic test image to the selected model and checks its function call. A successful check allows Athena to open a new FreeCAD window with a private profile and operate the visible Part workbench, document tree, Save As dialog and STEP export dialog. The actual final window image is an image part in the Pi tool result. The conversation retains it locally. Later model turns omit it.

The window controls support creating a new block with a through-hole. API editing operates on Athena's parametric FCStd artifacts. Connections without declared image support show the reason in the panel. For an operator-configured compatible endpoint, `ATHENA_MODEL_IMAGE_INPUT=1` declares image input for the configured model. The live image and tool call check still runs before any FreeCAD pixels are sent.

**Stop** revokes input. **Take over FreeCAD** also records the handoff and leaves the owned window available for manual work. Each app action needs a current app, window, document and screen observation. The input lease coordinates Athena hosts, and a separate writer lock coordinates API and UI access to the same project document. A denied or unconfirmed write cannot trigger GUI fallback. Restarting preserves the pending output directory and discards old input.

Use **Check existing files** after an interrupted write. It opens the two existing outputs for a read-only geometry check and can publish them if they pass. A confirmed missing or invalid output preserves the staged files and allows a new attempt in a separate directory. A verification failure with an uncertain cause retains the recovery requirement.

## Verification

Linux FreeCAD 1.0.0 ran both authoring paths. Each produced `test_part.FCStd` and `test_part.step`. The independent verification process opened both files and found one closed, valid 40 × 20 × 10 mm solid with a centered 6 mm through-hole and a volume of 7717.256661 mm³. The host compared the scoped directory entries, file identities, timestamps and bytes across verification. The API edit increased the width to 24 mm and preserved the original artifact bytes after a host restart.

The GUI acceptance test sets the authoring adapter to unsupported before admission. The real FreeCAD window creates and saves the files on a Linux X11 display. The controlled provider receives the PNG captured from that window as actual image content. The tests also exercise stopping after a real GUI write, taking over during input, refusing another write before recovery, and checking the staged outputs after reinitializing the host.

```sh
ATHENA_TEST_FREECAD=api node --test tests/freecad-acceptance.test.ts
# Run on an interactive Linux display with FreeCAD installed.
ATHENA_TEST_FREECAD=gui node --test tests/freecad-acceptance.test.ts
```

The loopback provider responses are fixtures. The cloud's configured model endpoint returned HTTP 404, so live model and account acceptance is **NOT RUN**. Native macOS and Windows GUI automation are **NOT RUN** in the Linux workspace. The generated UI and native package checks measure assembly, separately from the actual FreeCAD execution above.
