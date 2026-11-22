# Athena M4.2 로컬 납품 기록

M4.1 `79f2fce8d7f9776b0d85d5fa22c62c56e9614ef9`에서 분기했다. 제품의 Docker 실행 경로를 제거하고 기존 TaskManager와 Pi에 오프라인 WASI 실행기를 연결했다. 프로젝트별 허용은 기본으로 꺼져 있다. CPython은 표준 라이브러리, JavaScript의 `node` 요청은 QuickJS-ng를 사용한다. 기존 Docker 결과와 해시는 그대로 읽는다.

| 목표 | 판정 | 증거와 남은 조건 |
|---|---|---|
| Docker 없는 분석 | CONTROLLED | `a8c26d3` 추출본의 번들 Node에서 실제 Qwen 14B Python CSV 분석과 QuickJS 파일 출력을 검증했다. 두 회차 모두 재시작 전후 다운로드 바이트가 일치했다. 이 시험에는 Docker CLI 없는 `PATH`와 유효하지 않은 소켓을 사용했다. 별도 Docker 없는 macOS VM에서는 `725e4bc` 앱과 번들 Node의 기동을 확인했다. 게스트 안에서의 분석 실행은 아직 확인하지 않았다. |
| 오픈소스 공개 | PENDING | [감사 결과](release-audit.md), 라이선스·고지 초안, 운영 문서, Docker 없는 CI 구성과 로컬 ZIP을 준비했다. 격리된 `725e4bc`의 일반 Finder 첫 실행은 Gatekeeper가 차단했다. 권리 승인, 최종 고지, 서명·공증 후 설치 재시험, GitHub CI 실행이 남아 있다. |
| 실제 ChatGPT OAuth | PENDING | [공식 문서와 통제 검증](siwc.md)을 기록했다. Athena 배포 자격과 사용자의 직접 동의를 확인하지 못해 로그인, 실계정 모델 조회, Responses/Codex 실행과 실계정 철회를 수행하지 않았다. |

Keychain 안내를 수정한 로컬 검토본은 `Athena-m42-arm64-7f62be5-review.zip`이다(SHA-256 `07b483ce225e63e6a1291d2343fb7ff825dcc4f5bf15a86f0c6e76dee93946e6`). ZIP 항목 36,849개에서 지정한 홈·빌드 경로와 공유 설치 권한을 검사했고, 주 실행 파일에서 새 취소·인증 실패 안내를 확인했다. 호스트에서 ZIP을 풀어 엄격한 앱 봉인 검사와 번들 Python·QuickJS, 합성 보관소 보존 및 재시작 후 Pi 스트리밍·도구 검사를 통과했다. 실제 게스트의 Keychain 거부·복구 및 격리 다운로드 후 Finder 첫 실행은 미확인이다.

`7f62be5`의 호스트 배포 판정은 **FAIL**이다. 체크섬을 대조한 ZIP 추출본은 `codesign --verify --deep --strict`를 통과했지만 `spctl --assess --type execute -vv`는 `rejected`(종료 코드 3), `syspolicy_check distribution`은 공증 티켓 누락(종료 코드 70)을 보고했다. 이 검사는 앱을 실행하지 않았다. 정식 배포 후보를 Developer ID로 서명하고 공증 티켓을 첨부한 뒤 격리 다운로드와 게스트 Finder 첫 실행을 검사해야 한다.

Apple Silicon macOS 27.2에서 타입 검사, 백엔드 **122/122**, UI DOM **103/103**, UI 계약 **78/78**을 통과했다. `codesign --verify --deep --strict`로 ad-hoc 봉인을 확인했다. Developer ID와 Team ID는 없다. WASI 도구 인자 안내 수정 `2b65a6a`가 들어간 새 ARM64 빌드에서 번들 검증, ZIP 무결성 검사, 별도 추출본 서명 검증을 통과했다. 기존 ZIP은 이전 인수 기록을 가리킨다.

```text
aec7d949d1c48f3f1b96b8ec6cf9690887d47bdd16767c42df7849e4e1dc61ee  Athena-m42-arm64-final.zip
c164b7e645ab5a5946b7409fcaa1d8d923ad13a8ff9ece476943b0b19c1253d4  Athena-m42-arm64-2b65a6a.zip
642412c1e8c9d7c02a42be5af067e54351c5782e77a3972c0ee8b544fdfcc712  Athena-m42-arm64-16f37e2.zip
6facef3607ea384c05120299314b6f9f3f1ee92d9d1748aee3face6e3f11b061  Athena-m42-arm64-725e4bc.zip
06c3e5153f2bc25f6ebe1a69023e37c650aa171250a204b3da39f5a7cec2514d  Athena-m42-arm64-a8c26d3.zip
```

실제 Qwen 기능 인수 기준본 `a8c26d3`는 Pulley 도우미를 포함한다. ZIP 무결성과 별도 추출본의 엄격한 서명 검사를 통과했다. 내부 실행 파일 세 개는 각각 빌드본과 바이트가 같았고, 추출된 분석 도우미의 Hardened Runtime과 entitlement 부재를 확인했다. 추출본의 호스트 실행 평가는 `3`, 배포 평가는 `70`(ad-hoc 서명, 공증 티켓 없음)이었다.

`a8c26d3` 추출본에서 실제 Qwen 14B 실행 `637778f4-76db-4e9d-b0c8-b6faf16f8659`이 성공했다. 독립 자식 두 세션을 기다린 부모가 Python WASI 프로세스 `0ecea9c4-9b82-422a-bf92-c7007571300a`의 `result.json`을 직접 읽었다. T2를 제외한 행은 T3, T4, T1, T5 순서였고 중앙값은 15 ms, 모집단 표준편차는 6.708203932499369 ms였다. 인증된 HTTP 다운로드로 아티팩트 세 개를 받았고, 번들 Node를 종료한 뒤 새 프로세스에서 다시 받아 바이트와 해시를 비교했다. 저장 프로필·실행 이력과 SQLite `integrity_check=ok`도 확인했다. 이 회차는 번들 HTTP 검증이다. 아래 Finder·Chromium·깨끗한 macOS 검증은 표시된 이전 후보를 사용했다.

| `a8c26d3` Qwen CSV 아티팩트 | 크기 | SHA-256 |
|---|---:|---|
| `analysis.py` | 1,391 B | `1801f50236a0b70055c71c21cf2c0a746ec8ca6f83a4a4d874b98423bff4be5e` |
| `clean.csv` | 54 B | `de4abe8cfcb956f3ea5d99eb7fac8771d8dd99323b7d833f1bd53be3f762363a` |
| `result.json` | 58 B | `4198576252b2d518df64a6b99107d61840b06579ef1fe429eff4449db332ed5f` |

같은 `a8c26d3` ZIP의 새 Qwen 14B QuickJS 실행 `6c3bcc3d-eaff-4023-9289-d46c1d401a45`이 성공했다. 독립 자식이 작성한 스크립트를 QuickJS WASI 프로세스 `98435689-039f-408d-9227-bb3ac3f70123`이 실행했다. 부모는 `wait_for_agents({})`로 자식을 기다린 뒤 `js-result.txt`를 아티팩트 ID로 직접 읽었다. 모델이 작성한 소스와 결과를 인증된 HTTP로 내려받았고, 새 번들 Node 프로세스에서 동일 바이트·실행 이력·프로필을 확인했다. 다른 환경의 Finder 검증으로 보지 않는다. 앞선 실행 `9840f206-1185-4357-a623-1a929201a9cd`는 파일을 만들었으나 부모가 작업 ID 대신 자식 이름을 넘겨 대기에 실패했으므로 인수 통과에 포함하지 않는다.

| `a8c26d3` Qwen QuickJS 아티팩트 | 크기 | SHA-256 |
|---|---:|---|
| `analysis.mjs` | 120 B | `38fab164a35c4f96fce481805aaf646d740f56a7f1c50e1b93c430e1db818f59` |
| `js-result.txt` | 13 B | `e71f8db8258d134a6bdff613318e2a010be28731046053d61c7b13a2b9332db6` |

별도 추출본에서 `--verify-only`로 서명·Python·QuickJS·Node 재시작을 재검증했다. 실행 전후 앱 안의 모든 일반 파일 SHA-256은 같았고, 시험 복사본에 서명되지 않은 리소스를 추가하자 검사에 실패했다. `--release`는 현재 ad-hoc 후보를 Developer ID 요구 조건에서 거부했다. 정식 서명·공증된 후보의 양성 검증과 Finder 실행은 아직 하지 않았다.

공증 전에 이미 서명한 후보의 Hardened Runtime, entitlement, 서명 팀과 Pi 네이티브 모듈을 검사할 수 있도록 `--pre-notarization`을 추가했다. `a8c26d3` ZIP의 새 추출본에서 이 모드와 `--release`가 모두 Developer ID 요건에서 ad-hoc 서명을 거부했다. 같은 추출본의 `--verify-only`는 번들 Node로 Python·QuickJS 산출물과 재시작 후 프로필·스트리밍·도구 호출을 확인했다. 공증 티켓과 Gatekeeper 검사는 계속 `--release`에서 요구한다. Developer ID 후보가 없어 두 서명 모드의 양성 경로는 미검증이다.

게스트용 `--verify-only` 검사는 Xcode의 `lipo` 대신 macOS 기본 `file`로 도우미가 단일 ARM64 실행 파일인지 확인한다. 호스트에서 `a8c26d3`와 `725e4bc`를 각각 새로 추출한 뒤, 시스템 기본 `PATH`와 존재하지 않는 `DEVELOPER_DIR`로 각 앱의 번들 Node를 사용했다. 두 후보 모두 서명과 Python·QuickJS 산출물, 통제 보관소의 프로필 복원 및 스트리밍·도구 호출 검사를 통과했다. 이 결과는 개발용 Node나 Xcode 도구 없이 검사기를 호출할 수 있다는 호스트 증거다. 게스트에서 같은 검사기를 실행한 결과나 Keychain 인증 결과는 아니다.

로컬 ZIP `Athena-m42-arm64-16f37e2.zip`은 Pi의 미사용 DOOM 예제를 제외한다. 번들 검사가 기존 앱에서 이 예제를 검출해 실패했고, 재빌드에서는 통과했다. Python·JavaScript 산출물, 번들 Node 재시작, 저장 프로필 및 통제 인증 스트리밍·도구를 재검증했다. ZIP 무결성, 추출본의 ad-hoc 서명과 예제 제외도 확인했다. 아래 Python 실모델 및 Finder QA 인수는 해당 회차에 표시된 각 후보를 사용했다.

최신 로컬 ZIP `Athena-m42-arm64-725e4bc.zip`에는 QuickJS 파일 API 안내 수정이 들어 있다. 타입 검사와 백엔드 회귀, ARM64 번들 검사를 통과했고, ZIP 무결성 검사, 별도 추출본의 엄격한 서명 검증 및 도구 소스 대조도 통과했다. 정식 배포 검사 `syspolicy_check distribution`은 공증 티켓 누락을 보고하며 종료 코드 `70`을 반환했다.

`2b65a6a`와 `16f37e2` 추출본의 `Contents/Resources/host`를 경로와 바이트로 비교했다. 예제 디렉터리 안의 파일 10개만 빠졌고, 남은 16,128개는 모두 같았다. 번들 `athena-node`와 `athena-sandbox`도 동일했으며 `athena-desktop` 실행 파일의 해시는 달랐다.

`16f37e2` ZIP 추출본의 `syspolicy_check distribution`도 종료 코드 `70`을 반환했다. ad-hoc 서명과 누락된 공증 티켓이 배포 검사 오류로 표시됐다.

깨끗한 Mac 인수용으로 Apple macOS 27.2.1 복원 이미지 `26B131`(SHA-256 `233e85a09887579d47d0b195e7db72be7f204261059c6946f719acf6b300814f`)에서 별도 ARM64 게스트를 설치했다. 초기 설정을 마친 게스트에서 Finder와 읽기 전용 공유 볼륨을 확인했다. 첫 Tart 실행이 종료된 뒤 같은 게스트 디스크에서 재부팅했고, 생성된 로컬 계정의 로그인 화면까지 도달했다.

게스트 터미널의 읽기 전용 검사에서 macOS `27.2.1` / 빌드 `26B131` / `arm64`를 확인했다. `docker`는 `PATH`에 없었고, 일반적인 Docker 설치 경로·런타임 프로세스·소켓은 각각 0건이었다. 호스트에서 실행 중인 Docker는 중지하지 않았다.

2026-11-21 후속 관측에서 사용자가 열어 둔 `athena-m42-clean` VM의 네이티브 Athena 창과 **Settings → Models & connections** 화면을 확인했다. 같은 VM의 Terminal에서 사용자가 실행한 `inspect-running-desktop.sh`는 앱 PID `2395`, 같은 번들의 Node 자식 PID `2407`, 수신 주소 `127.0.0.1:49152`, `App quarantine: present`를 보고했다. 이 출력에 도달하려면 실행 중인 앱 경로의 `codesign --verify --deep --strict`가 성공해야 한다. 아래 세 SHA-256은 모두 호스트의 `Athena-m42-arm64-725e4bc.zip`에서 직접 꺼낸 실행 파일과 일치했다. **Docker 없는 게스트에서 `725e4bc` 앱과 백엔드 기동은 PASS**다. 이번에 앱을 여는 데 사용한 경로와 승인 절차는 관측하지 않았다. 게스트의 모델 설정과 분석 실행은 PENDING이며, 아래의 일반 Finder 첫 실행 실패 및 정식 배포 인수와 구분한다.

| 게스트에서 확인한 실행 파일 | SHA-256 |
|---|---|
| `athena-desktop` | `148e191e372c35946b9d4f8278d03f4a13ebec416bda271cad411d5da7a3ce5f` |
| `athena-node` | `ba7073582822078d8c90bca3facacc46690bc5366fab4b815aeef9148cd6e854` |
| `athena-sandbox` | `e371299bab6d94b61ee85f8761df008887da2cca16e70d5552d73b7e75cdb541` |

게스트 Safari는 최신 `725e4bc` ZIP(105,785,408바이트)을 다운로드해 자동으로 풀었다. 생성된 `Athena.app`에는 `com.apple.quarantine`이 있었고, 게스트 `codesign --verify --deep --strict`는 `0`을 반환했다. 앱의 `athena-desktop` 실행 파일 SHA-256 `148e191e372c35946b9d4f8278d03f4a13ebec416bda271cad411d5da7a3ce5f`는 호스트 추출본과 일치했다. 게스트의 실행 평가 `spctl --assess --type execute`는 `3`(`rejected`), `syspolicy_check distribution`은 `70`(`Adhoc Signed App`, `Notary Ticket Missing`)을 반환했다. Finder에서 일반 실행하자 Gatekeeper가 **‘Athena’을(를) 열지 않음**을 표시했다. 깨끗한 환경의 배포 앱 시작은 **FAIL**, 그 환경의 실제 분석 실행은 **PENDING**이다.

Safari가 압축 해제 후 휴지통에 넣은 원본 ZIP을 Finder에서 다운로드 폴더로 복사한 뒤, 게스트 터미널의 읽기 전용 검사를 마쳤다. ZIP의 SHA-256 `6facef3607ea384c05120299314b6f9f3f1ee92d9d1748aee3face6e3f11b061`은 호스트의 `SHA256SUMS`와 일치했고, ZIP과 추출 앱 모두 `com.apple.quarantine`이 유지됐다. 같은 검사에서 엄격한 서명 검사 `0`, 실행 평가 `3`, 배포 평가 `70`을 다시 확인했다. 원본 ZIP 검증은 **PASS**이며 Finder 첫 실행 **FAIL** 판정은 그대로다. 호스트의 코드 서명 가능 ID를 확인했으나 Developer ID Application 인증서가 0건이었다. 정식으로 서명·공증한 후보가 있어야 Finder 실행과 그 뒤의 분석을 다시 검증할 수 있다.

추가 서명 시험에서 기존 Wasmtime 네이티브 코드 생성 도우미는 Hardened Runtime을 적용하면 QuickJS의 준비 신호를 내기 전에 종료됐다. `allow-jit`만 추가한 복사본도 실패했고, `allow-unsigned-executable-memory`를 부여한 별도 진단 복사본에서만 성공했다. 실행 메모리 권한을 부여하는 대신 도우미를 Wasmtime의 Pulley 바이트코드 해석 경로로 변경했다. 로컬 ARM64 앱에서 entitlement 없이 Hardened Runtime으로 서명한 도우미가 번들 Python과 QuickJS 출력을 모두 만들었다. 타입 검사, 백엔드 회귀 122/122, 번들의 산출물 바이트·인증된 Node 재시작·프로필 및 Pi 스트리밍·도구 검증을 통과했다. 별도 Node 서명 실험에서는 권한 없는 Hardened Runtime으로 다시 서명하면 V8 시작이 실패했고, `allow-jit`만 부여한 복사본은 Node 및 WebAssembly 스모크를 통과했다. 이는 로컬 통제 서명 시험이다. Developer ID 서명, 공증, 깨끗한 환경 실행은 별도 인수로 남아 있다.

별도 디렉터리에 `ab44b8a241b4c4c908db81397792c937b6852e09`의 추적 소스만 내보내고, 기존 `node_modules`나 빌드 산출물 없이 `npm ci --ignore-scripts`와 `npm run desktop:build`를 실행했다. ARM64 빌드·서명·번들 검증을 통과했다. 두 번들의 호스트 리소스 16,138개 중 16,137개가 같았고, 분석 런타임 출처 파일은 네이티브 헬퍼 해시만 달랐다. Node와 두 WASM 파일은 바이트가 같았지만 `athena-desktop`과 `athena-sandbox`의 실행 파일 해시는 달랐다. 같은 잠금 입력으로 동작하는 앱을 다시 빌드할 수 있었으며, 바이너리까지 바이트 단위로 재현되지 않았다.

배포 ZIP을 새 경로에 추출한 별도 검사에서는 SHA-256과 서명을 확인하고, 비어 있는 작업공간에서 번들의 Node 호스트를 세 번 시작했다. 익명 요청은 401, 교차 출처 요청은 403을 반환했다. 다른 키로는 `VAULT_KEY_MISMATCH`로 시작을 거부했고, 복사본에서 Python WASM을 잠시 제거했을 때 분석 상태가 꺼지고 `EXECUTION_UNAVAILABLE`로 재활성화를 거부했다. WASM을 복원한 뒤 같은 프로젝트와 권한이 돌아왔고 보관소 SHA-256과 `0600` 모드가 유지됐다. 원본 앱과 작업공간을 변경하지 않았다. 이 검사는 같은 Mac의 통제 키를 사용한 검사이며, 깨끗한 별도 Mac의 Finder·Gatekeeper 인수가 아니다.

같은 추출본의 `syspolicy_check distribution` 결과는 종료 코드 70이었다. ad-hoc 서명과 공증 티켓 부재가 보고됐다. 이 후보는 로컬 검증용이다. 외부 설치 검증과 기존 Keychain 작업공간 인수는 [설치 문서](../installation.md)의 절차에 따른다.

최종 번들의 인증된 호스트에서 실제 로컬 Qwen3-4B-Instruct를 사용했다. Python 실행 `34a8e092-251c-434e-805e-731309d9705b`는 부모와 독립 자식 두 명의 기록을 남겼다. WASI 프로세스 `d44c5f6e-9ec6-4b68-8c96-ea27b19cfc1c`에서 모델이 작성한 Python이 끝났고, 실행 기록에 실제 `result.json` ID를 읽은 성공한 `read_file` 호출이 남았다. 이 검사는 호출 주체를 구분하지 않았다. 독립 검산에서 T2의 빈 값을 제외한 후 T3=6, T4=12, T1=18, T5=24 ms 순서였다. 중앙값은 **15 ms**, 모집단 표준편차는 **6.708203932499369 ms**였다.

별도 실행 `d7989835-4f5a-4160-b04d-ae5df1357275`에서는 부모 소유의 성공한 `read_file` 호출이 없었고, 부모가 모집단 표준편차를 6.0 ms로 보고했다. 원인 분리를 위한 새 실행 `d65a59d5-f272-44ed-bbe9-75f68a844d89`에서 부모는 자식 결과를 기다렸지만 `read_file`을 호출하지 않았고, CSV 자체도 검산에서 탈락했다. 부모가 파일을 직접 확인해 올바르게 답하는 인수 조건은 실패했다. 통제 오케스트레이션 테스트에서 확인한 부모의 결과 읽기 권한과 별개다.

ZIP 추출본의 새 실행 `643c3201-0383-4e52-afb3-cdd49d548573`에서는 독립 자식이 첨부 원문을 읽고, 부모가 두 자식을 기다린 뒤 부모 세션의 `read_file`로 `result.json` (`b4753c93-91c6-4f1b-858c-4c17f58b9429`)을 읽었다. 최종 답변에 T2, ms, 중앙값 15, 모집단 표준편차 6.708203932499369, 두 실제 결과 URL이 모두 있었다. 다만 이 회차는 CSV 내용 단언에서 실패했고, 별도 JavaScript 실행도 결과를 내지 못했다. 다음 실행 `6b5a2313-be9f-4dbf-a135-ea834261ad75`에서는 수치가 맞았으나 `clean.csv`에 빈 T2 행이 남았고 부모가 `read_file`을 호출하지 않았다. 실행 `e15b5bb9-4e8c-44b8-bfa6-5a9d7b25349d`도 수치 파일은 맞았지만 CSV가 정렬되지 않았고 부모가 파일을 읽지 않은 채 잘못된 수치를 답했다. 부모 읽기 및 답변 성공은 첫 회차의 증거에 한정하며, 모든 CSV 인수 조건을 한 회차에서 통과한 것으로 집계하지 않는다.

추가 통합 실행 `acd3d976-facc-457d-af49-9a8d6cadd1d7`은 두 자식과 Python WASI로 올바른 CSV·JSON을 만들었지만 부모의 `read_file` 호출이 없어 전체 검증에 실패했다. 다음 인수부터는 `node scripts/inspect-m21.mjs DATA_DIR RUN_ID`의 비공개 출력과 실제 다운로드를 `node scripts/m21-browser-verify.mjs INSPECTION.json DOWNLOAD_DIR --wasi`로 대조한다. 다운로드는 `DOWNLOAD_DIR/<artifact-id>/<original-name>`에 둔다. 이 검사는 같은 실행의 Python WASI 프로세스, 다운로드 바이트, 부모가 읽은 JSON 원문을 대조하며 기존 Docker 기록도 기본 모드에서 계속 검사할 수 있다.

Qwen 4B 실행 `27719ceb-dec4-46a9-ac51-e9d4f1d137d7`에서는 자식이 실제 Python WASI를 호출했으나 코드가 존재하지 않는 `measurement` 열을 참조해 종료 코드 1을 반환했다. 부모가 읽은 파일은 다른 자식의 고정 CSV 계산으로 생성된 `statistics.json`이었다. `clean.csv`와 `result.json`은 게시되지 않았으므로 이 회차는 다운로드·재기동 인수에 포함하지 않는다.

이전 ZIP의 Qwen 14B 실행 `e554f86c-84b5-42e8-9b5d-5599295caf0e`에서는 프로그래머가 `run_command.inputs[0]`에 게스트 경로 대신 베이스 이름을 써야 하는 구분을 놓쳐 같은 호출을 반복했다. 부모가 읽은 JSON은 감사자 출력이었고 `clean.csv`는 게시되지 않았다. `2b65a6a`는 거부된 인자 위치와 올바른 베이스 이름을 안내한다. 경로를 허용하도록 검사를 완화하지 않았다. 같은 잘못된 입력과 출력 인자가 모두 거부되고 수정된 호출만 실행·게시되는 것을 통제 테스트로 확인했다.

수정된 ZIP의 Qwen 14B 실행 `5f46b916-b26a-4484-8328-3e6fda49666c`에서 모델은 경로 오류 안내를 받은 뒤 `inputs`를 `settling.csv`로 고쳤다. WASI가 첨부 파일의 정확한 버전을 마운트했고 부모도 게시된 JSON을 직접 읽었다. 그러나 모델이 작성한 코드가 `T1` 같은 문자열 식별자를 정수로 변환하려다 유효한 행을 모두 건너뛰었다. `clean.csv`에는 헤더만 남았고 두 통계는 `null`이었다. 검산에서 실패했으므로 이 회차에는 다운로드·재기동 통과를 부여하지 않았다.

**새 ZIP에서 실모델 CSV와 Chromium 재다운로드 통과.** Qwen3-14B-Q4_K_M 실행 `c02413f1-72f7-453b-90db-6e32352237e1`에서는 문자열 식별자 `trial`을 그대로 유지하도록 명시했다. 독립 자식 두 명이 원본 감사와 Python WASI 실행을 맡았고 부모가 `result.json`을 직접 읽었다. T2를 제외한 CSV는 T3=6, T4=12, T1=18, T5=24 ms 순서였다. JSON의 중앙값은 15 ms, 모집단 표준편차는 6.708203932499369 ms였다. 부모 답변은 T2, 단위, 두 통계와 결과 링크 두 개를 포함했다. `--wasi` 인수 검증기가 같은 실행의 Chromium 저장 파일을 재기동 전후 모두 통과시켰다. 번들 Node PID 변경, 같은 프로필, 불변 실행 기록과 에이전트 이력 SHA-256 `f4ba47635bcef3534a10fa2cd60473c11548f2eb4091ba6a3a03bccf719e2c37`도 확인했다. 이 회차는 격리 보관소 키를 사용했다.

| 실행 `c02413f1`의 실제 다운로드 | 크기 | 재기동 전후 SHA-256 |
|---|---:|---|
| `analysis.py` | 1504 B | `b4be120085f8943b56c1ad7abd21ea64ae74c214429633fce99a3416f7b5914f` |
| `clean.csv` | 54 B | `de4abe8cfcb956f3ea5d99eb7fac8771d8dd99323b7d833f1bd53be3f762363a` |
| `result.json` | 58 B | `4198576252b2d518df64a6b99107d61840b06579ef1fe429eff4449db332ed5f` |
| `statistics.json` (감사자 고정 계산) | 171 B | `8500b288d69051ab605c2d7d95a40c421322a80042e8145873a91840a4b1e578` |

**최신 ZIP의 별도 실모델 회차 `ec0558ec-f677-44dd-a6e4-f9c8b6e0980e`도 통과했다.** ZIP 추출본의 번들 Node에서 Qwen 14B의 자식 두 명이 독립 세션으로 실행됐고, Python WASI가 T2를 제외한 CSV와 중앙값 15 ms, 모집단 표준편차 6.708203932499369 ms를 계산했다. 부모가 이 회차의 `result.json`을 직접 읽었다. Chromium UI에서 네 파일을 저장하고, 번들 Node 재시작 뒤 같은 대화에서 다시 내려받았다. 여덟 다운로드를 대조했고, 재시작 전후의 각 파일은 서로 같은 바이트였으며 각각 위 표의 크기와 SHA-256도 일치했다. 재시작 전후 실행 이력 SHA-256은 `2443dc6d41a793d25bff74fa096af62096488a3d2f43c2a088a573e9df7e7da4`, 종료 후 SQLite 무결성 검사는 `ok`였다. 보관소는 통제 키를 사용했다. 최신 ZIP의 Finder 재실행이나 Docker 데몬이 없는 별도 Mac에서의 실행을 뜻하지 않는다.

최신 ZIP에서 파생한 네이티브 QA 앱에는 같은 회차의 작업공간을 복사하되 통제 키와 보관소는 제외했다. 오프라인 검증으로 독립 Pi 세션 세 개와 아티팩트 네 개의 크기·해시를 대조한 뒤 LaunchServices로 QA 앱을 열었다. 앱 PID `35932`가 번들 Node PID `35941`을 시작했고, 새 보관소는 30바이트·`0600`으로 초기화됐다. Node는 `127.0.0.1:50619`에서 수신했고 익명 `/api/bootstrap`은 HTTP 401을 반환했다. SQL 무결성은 `ok`이고 같은 실행 ID의 상태가 `succeeded`로 유지됐다. 창 내용을 직접 확인하지 못해 이 시험은 최신 ZIP의 네이티브 시작 증거까지만 사용한다.

`725e4bc`의 실모델 CSV 실행 `4f3e0c20-b12e-4ea6-bcff-8d633e318e56`도 통과했다. 번들 Node에서 Qwen 14B가 독립 자식 두 명을 실행했고, Python WASI 프로세스 `9f940686-ef14-485b-bc45-bc9e0a88e4a2`가 분석 파일을 만들었다. 부모가 해당 프로세스의 `result.json`을 읽었다. T2를 제외한 순서는 T3=6, T4=12, T1=18, T5=24 ms였고 중앙값은 15 ms, 모집단 표준편차는 6.708203932499369 ms였다. 두 자식이 같은 이름의 파일을 게시했으므로 파일 이름이 아닌 프로세스와 아티팩트 ID를 기준으로 결과를 대조했다. Chromium에서 다섯 파일을 저장하고 번들 Node를 재시작한 뒤 같은 대화에서 다시 받았다. 10개 다운로드의 바이트, 실행 기록, 에이전트 이력, 모델 프로필이 각 검사에서 일치했다. 분석 프로세스의 `clean.csv` SHA-256은 `86b1039f15e04e0d78b6071ee470609217323a6ddd5ed811aaaf53b1a497c307`, `result.json`은 `4198576252b2d518df64a6b99107d61840b06579ef1fe429eff4449db332ed5f`였다. 종료 후 SQLite 무결성 검사는 `ok`였다.

| 인증된 다운로드 | SHA-256 |
|---|---|
| `analysis.py` | `6d11278f7a45a90934c94a75f2a8e4b5f8a177538b534dc83b57329fb82f101d` |
| `clean.csv` | `de4abe8cfcb956f3ea5d99eb7fac8771d8dd99323b7d833f1bd53be3f762363a` |
| `result.json` | `4198576252b2d518df64a6b99107d61840b06579ef1fe429eff4449db332ed5f` |
| `analysis.mjs` | `492bdf22c0e8a1f651ed6ee52a23e5ac97692aef85e9d9747def77f1b58e4975` |
| `js-result.txt` | `c42e825abe7dbe6fbc79c6f92373085ff55f33323e2c70f800d7ce5560670d8a` |

JavaScript 실행 `2fd3357a-fb5e-415f-b9dc-d2dc32cf7d7c`는 번들 QuickJS에서 `QA-JAVASCRIPT`를 썼다. 별도 번들 Node 프로세스와 새 포트에서 프로필·실행·작업·도구 기록, 에이전트 이력 해시와 각 다운로드 바이트가 일치했다(74588:49160 → 74889:49199). 이 검사는 통제 보관소 키를 전달한 실모델 RPC 검사다.

`16f37e2`의 별도 진단 실행 `f21643f6-c744-44bd-b3e7-c16dfe9dc2c6`에서 Qwen 14B가 `qjs:std`에 없는 `std.fs.open`을 반복 호출했다. 확인한 `qjs.wasm` 프로세스는 `TypeError: cannot read property 'open' of undefined`와 종료 코드 `1`을 남겼고, 새 결과를 게시하지 못한 채 시험 제한 시간에 도달했다. `725e4bc`는 실행기나 권한을 변경하지 않고 `run_command`에 `std.loadFile`, `std.open`, `puts`, `close`를 안내한다. 수정된 번들의 새 Qwen 14B 실행 `7c082eda-3099-4d8d-8d80-75c7ee2df29d`에서 부모와 자식이 독립 세션을 사용했고, QuickJS 실행 `6f293064-0cfe-4155-aa1f-9f3cc0daface`가 모델 작성 `analysis.mjs`(134바이트, SHA-256 `3828a06ff784977693b4782ea0e8a56849410e8cb2436518adb5cdd1c6fb1362`)와 `js-result.txt`(13바이트, SHA-256 `c42e825abe7dbe6fbc79c6f92373085ff55f33323e2c70f800d7ce5560670d8a`)를 게시했다. 통제 보관소 키를 사용한 번들 Node RPC 시험에서 PID/포트를 `49801:54708`에서 `50056:54725`로 바꾼 뒤 같은 기록과 파일 바이트를 확인했다.

ZIP 추출본의 번들 UI를 격리 Chromium에서 열고 **Artifacts → Download result file**을 클릭했다. 통제 모델이 WASI로 만든 실행 `173e3201-bae0-4499-a6e5-7fa04665cb1b`의 `proof.py`와 `proof.json`을 실제로 저장했다. 번들 Node 호스트를 종료해 새 프로세스로 시작한 뒤 같은 대화에서 다시 내려받았고, 두 파일의 크기와 SHA-256이 저장 기록과 일치했다. SHA-256은 각각 `7724249cdf0f3ed0ffdd2e25e85cf6ef8b62f2c9f19c069e3efb135126a9117d`, `71a7a1e010e444c9f2ff9c142d5f050c4ca42e06db6d2f2bf38002c0bae36d55`이다. 이는 통제 모델과 Chromium으로 검증한 UI 동작이며, Finder에서 연 WKWebView와 Keychain을 통한 인수는 남았다.

Finder로 연 별도 QA 앱에서는 새 작업공간, 프로젝트별 허용, Qwen 선택과 실제 CSV 첨부, 두 독립 자식, 쓰기 금지 경로 거부와 정상 종료를 확인했다. 별도의 호스트 검사에서는 익명 HTML, bootstrap, SSE 요청에 401을 확인했다. 초기 두 Finder 실행은 분석 결과를 완성하지 못했다. 최종 RPC 검증 전에 만든 QA 복사본의 Finder 재실행은 macOS 키체인 승인에서 대기하다 `The Athena backend did not become ready. Reopen Athena to retry.`를 표시했다. 번들 Node 자식이 남아 있지 않았고 작업공간 화면은 열리지 않았다. 이 기록은 승인 대기 중 시간 초과이며, 사용자가 승인을 거부했거나 로그인 키체인이 잠겨 있었다는 증거가 아니다. 기존 앱의 운영 작업공간에는 손대지 않았다.

후속 Finder 재실행에서는 사용자가 macOS 키체인 창에서 직접 승인했다. 격리 앱 PID 9321과 번들 Node PID 9326이 시작됐고, Node는 `127.0.0.1:59730`에서 수신했다. WKWebView에서 기존 대화 두 건의 제목, 이전 실행 흐름, `Qwen Analysis 4B` 선택 및 Artifacts의 `statistics.json`을 확인했다. **Download result file**을 눌러 저장한 171바이트의 SHA-256은 이전 아티팩트 `fe687ca5-139b-456f-b0a4-21170d480d1f`의 `8500b288d69051ab605c2d7d95a40c421322a80042e8145873a91840a4b1e578`과 일치했다. 승인 전후 보관소는 30바이트, `0600`, SHA-256 `af697b7625f5f3055560cb5a92c226e2f56f13bd1350c4af4fd2028d4898c4b6`로 같았다. 앱 메뉴에서 정상 종료한 뒤 두 PID와 수신 포트가 사라졌고 SQLite 무결성 검사는 `ok`였다. 이 보관소에는 저장된 제공자 비밀이 없으며, 다운로드한 파일은 고정 CSV 도구의 결과다. Qwen 14B 회차의 WASI 파일과는 별개다.

별도의 M4.1→M4.2 통제 업그레이드에서 실제 기존 Docker 실행 `ae64aae3-03b2-4cf5-a81f-3acfc007d341`의 기록·원본 다운로드·부모 및 자식 이력이 같았다. 기존 보관소는 바이트와 `0600`이 유지됐고, 저장된 프로필의 스트리밍 및 도구 검증은 기존 합성 API 키로 다시 통과했다. 실제 Keychain 업그레이드 검증으로 간주하지 않는다. 원격 푸시 및 저장소 공개 전환은 하지 않았다.

실제 Keychain의 후속 시험에는 M4.1에서 사용자 입력으로 합성 제공자 키를 저장해 둔 별도 작업공간을 사용했다. `725e4bc`에서 파생한 M4.2 QA 앱이 기존 키체인 항목의 시스템 승인 창을 띄웠으나, 승인이 확인되기 전에 번들 Node가 종료됐다. 앱은 `The Athena backend did not become ready. Reopen Athena to retry.`를 표시했다. 이전 보관소는 136바이트, `0600`, SHA-256 `e7b1ab7a16d5bda0d9305d59e1ef4fb13833d1a0cbaa50ea2f74ac081f989a2a`로 그대로였다. 승인 대기 중 시작이 시간 초과된 회차이며, 키체인 접근 거부나 저장된 키로 인증 성공한 증거는 아니다.

실행 파일을 직접 열었던 회차는 `sandbox_extension_issue_file_to_process`의 `Operation not permitted`로 종료돼 앱·번들 Node를 관측하지 못했다. 이후 LaunchServices로 연 별도 QA 앱은 엄격한 서명 검사를 통과했고, 기존 M4.1 시험 작업공간을 열었다. 앱 PID `62058`의 자식인 번들 Node PID `62074`가 `127.0.0.1:60188`에서 준비됐다. QA용 서명과 작업공간 설정은 제품 ZIP과 분리했고, Node와 분석 도우미는 `725e4bc`와 바이트가 같다.

**네이티브 Keychain 보존 PASS.** M4.2 QA의 **Models & connections → Keychain QA endpoint → Refresh**로 모델을 조회했다. 자격 증명이 없는 대조 요청은 루프백 시험 서버에서 HTTP 401이었고, 앱 요청은 M4.1에서 저장했던 합성 키로 HTTP 200을 받아 `keychain-fixture`를 표시했다. 키를 다시 입력하거나 주입하지 않았다. 보관소는 기준본과 바이트가 같았고 136바이트, `0600`, 위 SHA-256을 유지했다. `connections.sqlite`의 `quick_check`는 `ok`였다. 이 QA 작업공간에는 저장된 모델 프로필이나 과거 실행이 없으며, 해당 보존 근거는 위의 별도 통제 업그레이드에 있다.

네이티브 오류 시험에서는 대응 키체인 항목이 없는 별도 작업공간에 기존 보관소의 복사본만 넣었다. ZIP에서 파생한 별도 QA 앱을 LaunchServices로 열자 `An existing Athena vault has no matching Keychain entry`가 표시됐다. 대화 화면은 열리지 않았고, 오류를 닫은 뒤 앱과 번들 Node가 남지 않았다. 보관소는 원본과 바이트가 같았으며 30바이트, `0600`, SHA-256 `36af53c35046aa70f1968c7a95cdc744395a4da6d993e4a8e23097aefa8f13e0`을 유지했다. 키 누락을 확인한 시험이다. OS 키체인 잠금·접근 거부 및 실제 ChatGPT 모델 권한 부족은 별도 검증 항목이다.

추가 백엔드 회귀는 작업공간 잠금을 획득한 뒤 시험 디렉터리의 쓰기 권한을 제한했다. 보관소를 새로 쓸 수 없으면 Node가 `VAULT_WRITE_FAILED`를 보고하고 준비 신호 없이 종료했다. 보관소나 임시 자격 증명 파일이 남지 않았다. 타입 검사 및 백엔드 **123/123**이 통과했다. 이 검사는 macOS 파일 권한 실패를 재현했으며 네이티브 Keychain 잠금·거부를 재현하지 않았다.

`a8c26d3` ZIP의 SHA-256과 앱 서명을 확인한 뒤, 추출본의 Node와 런타임으로 `tests/desktop-host.test.ts`의 보관소 시험 두 건을 실행했다(**2/2 PASS**, 종료 코드 0). 잘못된 합성 키를 전달하면 `VAULT_KEY_MISMATCH`로 준비 신호 없이 종료했고, 원래 키로 재시작하자 프로필 조회가 성공했다. 저장된 보관소 바이트는 시험 전후 같았다. 별도의 손상된 14바이트 보관소는 `VAULT_INVALID`로 구별했고 원본을 덮어쓰지 않았다. 두 시험 모두 호스트의 합성 작업공간에서 실행했다.

**번들 Node의 키 대기 시간 만료 및 복구 — CONTROLLED.** `a8c26d3` ZIP의 SHA-256과 추출한 앱의 서명을 확인한 뒤, 번들 Node로 임시 보관소를 만들었다. 두 번째 기동에서 키 요청을 받은 후 입력 파이프를 열어 둔 채 아무것도 보내지 않았다. 대기 시작 시점에 해당 PID의 TCP 수신 포트는 없었다. **305.0초 후** Node는 `ATHENA_DESKTOP_ERROR STARTUP_FAILED`를 출력하고 준비 신호 없이 코드 1로 종료했다. 기존 합성 키를 전달한 세 번째 기동은 준비 신호를 내고 정상 종료했다. 시간 만료 직후와 정상 재시작 후 모두 보관소 바이트와 `0600` 권한은 기준본과 같았다. 이 시험은 호스트에서 번들 Node의 타이머를 실제로 만료시킨 것으로, macOS Keychain 잠금이나 접근 거부를 시험한 것은 아니다.

**번들 Node 시작 중단 및 복구 CONTROLLED.** 해시를 확인한 최신 `a8c26d3` ZIP의 새 추출본에서 번들 Node로 `--verify-only`를 실행했다. 합성 자격 증명과 프로필을 저장한 뒤 두 번째 시작에서 `ATHENA_DESKTOP_KEYCHAIN`을 받자 키를 보내지 않고 시작 파이프를 닫았다. Node는 `STARTUP_FAILED`를 보고하고 준비 신호 없이 종료 코드 1로 끝났다. 보관소 바이트와 `0600` 모드는 그대로였고, 정상적으로 키를 전달한 다음 시작에서 저장 프로필의 Pi 스트리밍과 도구 호출이 루프백 시험 서버를 통해 성공했다. 대조 실행에서는 시작 파이프를 닫는 대신 합성 키를 전달하자 준비 신호가 나왔고 검사기가 이를 거부했다. 이 결과는 번들 Node의 실패 및 복구 동작을 확인한다. macOS Keychain 잠금·접근 거부는 여전히 **PENDING**이다.

같은 Qwen 14B 실행 `c02413f1-72f7-453b-90db-6e32352237e1`의 작업공간을 Finder용 QA 앱으로 옮겼다. QA 서명과 작업공간 지정은 배포 ZIP과 분리했다. 복사본의 파일 위치만 변경하고, 원래 실행 ID, 도구 메시지, 네 아티팩트의 해시를 대조했다. 기존 통제 키나 보관소는 복사하지 않았다. Finder에서 대화와 모델, 두 자식의 기록이 복원됐고 사용자 승인 후 WKWebView의 **Download result file**에서 WASI가 만든 58바이트 `result.json`을 저장했다. 첫 앱/Node PID `41073`/`41092`와 포트 `61341`이 사라진 뒤 Finder에서 다시 열자 새 PID `87809`/`87814`와 포트 `65308`이 생겼다. 재다운로드한 `result (1).json`은 별개 파일이며 SHA-256 `4198576252b2d518df64a6b99107d61840b06579ef1fe429eff4449db332ed5f`로 두 Finder 다운로드 및 원래 Chromium 파일의 바이트가 모두 일치했다. QA 보관소는 30바이트, `0600`으로 해시가 유지됐다. 이 시험은 동일 실행의 복원과 JSON 재다운로드를 검증했다. 네 파일 전체의 재다운로드 검증은 Chromium에서 수행했다.
