# M4.2 연구 실행기 선정

기준은 M4.1 `79f2fce8d7f9776b0d85d5fa22c62c56e9614ef9`이다. 타입 검사와 Docker 이미지가 고정된 기존 테스트 117건을 실행해 모두 통과했다. `TaskManager`의 프로젝트 허용, 첨부 버전 및 자식 권한 검사, `AnalysisFiles`의 불변 스냅샷·원자적 게시와 해시 검증, `CsvJobRunner`의 대기열·취소·이력 복원은 유지한다. 게스트가 호스트 작업공간을 공유할 이유는 없다.

| 후보 | 언어와 배포 | 권한·자원 경계 | 판정 |
|---|---|---|---|
| Wasmtime + WASI Preview 1 | arm64 호스트에서 CPython과 QuickJS-ng WASM을 오프라인 실행할 수 있다. 두 배포물의 해시를 대조하고 표준 라이브러리와 JavaScript 파일 API를 실제로 불러왔다. | 디렉터리와 입출력을 명시적으로 제공한다. 네트워크는 끄고 메모리·시간을 제한할 수 있다. 기본 CLI의 디렉터리 권한만으로는 선언한 출력 이름을 강제할 수 없어 좁은 전용 호스트가 필요하다. | 채택 |
| Pyodide + QuickJS WASM | Pyodide에 NumPy·pandas용 포트가 있다. 초기 배포에선 추가 휠과 그 라이선스도 관리해야 한다. Node와 Wasm 사이의 Python↔JavaScript 브리지, Emscripten 파일과 가져오기 동작도 감사해야 한다. | Web Worker 또는 JS 전역 객체 제거만으로 권한 경계를 보장하지 않는다. WASI에서 쓰는 것처럼 인가된 파일만 전달하도록 별도 경계를 구성해야 한다. | 첫 릴리스에서 제외 |
| macOS Virtualization.framework | Linux 게스트에서 Python·Node와 일반 라이브러리를 실행할 수 있다. 게스트 이미지, 이미지 업데이트, 라이선스, 하이퍼바이저 entitlement와 macOS 배포 조건이 추가된다. | 게스트 네트워크를 빼고 좁은 입출력 채널을 설계할 수 있다. 별도 게스트도 입력·출력 및 전체 수명 제한은 필요하다. | 필요할 때 별도 평가 |
| 네이티브 Node/Python 자식 프로세스 또는 `node:vm` | 익숙한 ABI가 장점이다. | 프로세스·인터프리터 분리만으로는 호스트 파일·키체인·네트워크 접근을 제한하지 못한다. Node도 `vm`을 보안 경계로 쓰지 말라고 문서화한다. | 제외 |

CPython은 WASI 빌드의 `csv`, `json`, `statistics`, `pathlib` 등의 표준 라이브러리를 기준으로 한다. NumPy, pandas, pip 설치 및 임의 네이티브 확장은 제공하지 않는다. JavaScript 요청은 기존 `language: "node"` 값을 계속 받지만 QuickJS-ng를 실행한다. `qjs:std`로 승인 파일을 읽고 결과 파일을 쓸 수 있다. Node 내장 모듈, npm, 브라우저 DOM 및 `fetch`는 지원하지 않는다. 기존 `read_file`, `write_file`, `run_command`와 읽기 경로 `/workspace`, 쓰기 경로 `/outputs`를 유지한다.

신뢰 경계는 Wasmtime과 앱 소유 호스트다. 제한된 게스트 모듈과 표준 라이브러리는 빌드에서만 내려받고 실사용에서는 네트워크가 필요 없다. 앱이 관리하는 바이트 스냅샷을 읽기 전용으로 공개하고, 선언된 출력 파일만 제한된 임시 디렉터리에 쓸 수 있게 한다. 성공하고 게스트가 종료된 뒤 기존 게시 계약으로 결과를 복사한다. 이 문서는 선정 근거이며, 리소스 제한·차단·취소·실제 앱 결과는 별도의 인수 증거로 확인한다.

출처: [Wasmtime WASI API](https://docs.wasmtime.dev/api/wasmtime_wasi/struct.WasiCtxBuilder.html), [CPython WASI 지원 범위](https://peps.python.org/pep-0816/), [CPython WASI 바이너리](https://github.com/brettcannon/cpython-wasi-build/releases/tag/v3.15.2), [QuickJS-ng WASI 바이너리](https://github.com/quickjs-ng/quickjs/releases/tag/v0.18.0), [Pyodide](https://pyodide.org/en/stable/usage/index.html), [Apple Virtualization](https://developer.apple.com/documentation/virtualization), [Node `vm` 문서](https://nodejs.org/api/vm.html).
