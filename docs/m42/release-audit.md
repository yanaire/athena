# M4.2 공개 감사

**공개 보류.** 프로젝트 전체의 공개 라이선스가 확정되지 않았다. [권리자 검토용 초안](../../LICENSE-DRAFT.md)과 [제삼자 고지 초안](../../THIRD_PARTY_NOTICES.md)을 마련했다. 원본 UI 인계 자료, 로고와 아이콘, 일부 DesignBookmark 파생 코드의 공개 재배포 권한을 확인하지 못했다. Pi와 UI의 전체 고지문, 연결된 WASM 구성 요소의 고지문, MPL 적용 소스 제공 경로도 배포 전에 확정해야 한다.

| 검사 범위 | 결과 |
|---|---|
| 현재 소스와 추적·미무시 파일 | 검사 시점 기준 텍스트 파일 235개, 콘텐츠 미검사 바이너리 15개. 로컬 절대 경로, 비공개 호스트 패턴, 자격 증명 형태의 리터럴 후보를 검토 대상으로 남겼다. 값은 기록하지 않았다. |
| 로컬 이력 | `git rev-list HEAD --all`의 173개 커밋 객체와 경로로 분류한 고유 블롭 380개(텍스트 366개, 바이너리 14개)를 확인했다. 일반적인 개인 키·제공자 토큰·JWT 고신뢰 패턴에 맞는 값은 검출되지 않았다. 로컬 경로, 호스트, 자격 증명 형태의 테스트 값은 남아 있으며, 정규식 검사만으로 실제 비밀이나 개인 데이터가 없다고 결론 내리지 않는다. |
| 앱 리소스 | 런타임과 UI의 스테이징 목록 및 파일명·텍스트를 확인했다. 검사한 범위에서 실제 보관소, OAuth 상태 파일, 작업공간 DB, 개인 로그, Docker 빌드 자산은 발견되지 않았다. 제삼자 SDK 문서 예시와 CPython 상류 빌드 경로가 남아 있다. npm의 비대상 아키텍처 바이너리, 번들 데모, 링크된 WASM은 별도 출시 검토 대상이다. |

후속 검사에서는 `38d75b89c0385db993aaca4e4ca8fdb2a6aec852`와 당시 로컬 참조 209개의 객체 ID를 고정했다. 현재 트리의 경로 272개는 고유 UTF-8 블롭 256개와 바이너리 15개였다. 브랜치·태그·원격 추적 참조에 도달 가능한 커밋은 92개(텍스트 블롭 507개, 바이너리 15개), 로컬 체크포인트를 포함한 전체 참조에서는 커밋 289개(텍스트 508개, 바이너리 15개)였다. 커밋 메시지와 UTF-8 블롭에서 개인 키 헤더, GitHub·OpenAI·Anthropic·AWS 키 형식 및 JWT 형태에 해당하는 패턴은 검출되지 않았다. 값이나 파일 내용을 출력하지 않았다. 이 검사는 바이너리 내용, Git에 기록되지 않은 파일, 미등록 토큰 형식, 실제 공개 권한을 판정하지 않는다.

검사 기준을 `ef128f862cf63037dd69ef89c696f039f13e794f`로 갱신했다. 당시 HEAD와 로컬 참조 233개가 가리키는 객체 ID를 고정하고, 검사 전후에 그대로인지 확인했다. 참조 목록(`%(refname) %(objectname)`의 줄 단위 출력)의 SHA-256은 `8e699d165a76a3d2009656b7aaa58f5e50d705c42d25ec4f4ebe532ea23970b7`이다.

| 범위 | 커밋 메시지 | 고유 UTF-8 블롭 | 바이너리 블롭(내용 검사 제외) |
|---|---:|---:|---:|
| HEAD의 추적 경로 273개 | 해당 없음 | 257 | 15 |
| HEAD와 브랜치·태그·원격 추적 참조 11개 | 110 | 536 | 15 |
| HEAD와 로컬 체크포인트를 포함한 전체 참조 233개 | 331 | 537 | 15 |

같은 여섯 범주의 고신뢰 패턴은 표의 커밋 메시지와 UTF-8 블롭, 그리고 HEAD의 추적 경로명에서 검출되지 않았다. 범주별 합성 양성 표본을 먼저 확인했고, 검사에서는 개수만 출력했다. 과거 경로명 전체, 작성자 메타데이터, Git 밖의 파일, 바이너리 내용은 이 갱신의 범위에 포함하지 않았다. 외부 공개 전에 최종 공개 범위에서 다시 검사한다.

경로와 작성자 메타데이터는 `0ae506d4e3721d115c8dc50f69f864a9526af8ec` 및 당시 전체 로컬 참조 233개를 기준으로 별도 확인했다. 일반 참조가 가리키는 커밋 111개의 트리에는 디렉터리를 포함한 고유 경로 317개가 있었고, 전체 참조의 커밋 332개에서는 318개였다. 두 집합에서 검사한 토큰 형태, 이메일 주소 형태, Athena 보관소·연결 DB 파일명, 지정된 환경·키 파일명 패턴은 검출되지 않았다. 합성 양성 표본으로 각 패턴을 확인했다.

일반 참조의 작성자·커미터 이메일 필드에는 대소문자를 합쳐 고유 값 1개가 있었으며 GitHub의 `users.noreply.github.com` 형식이 아니었다. 전체 참조에는 그 외에 GitHub 비공개 이메일 형식 1개가 있었다. 분류만 기록했으며 주소와 이름은 출력하지 않았다. 이 결과는 주소의 공개 동의를 대신하지 않는다. 공개 대상에 이력을 포함할지 결정할 때 메타데이터를 권리자와 검토해야 하며, 기존 이력은 수정하지 않았다.

`eb3eee0f889c8e19fcd914ba57cb8f36ae59611d`에서 이력 검사를 갱신했다. 검사 전후 HEAD와 전체 참조 265개가 같았고 참조 목록의 SHA-256은 `6af56408644efc1778cc5670a2ac8dc520bb42bbddfb89cf88d36e4ee00b0ef6`이었다.

| 도달 가능한 범위 | 커밋 | 고유 UTF-8 블롭 | 내용 검사에서 제외한 바이너리 블롭 | 디렉터리 포함 고유 경로 |
|---|---:|---:|---:|---:|
| HEAD와 브랜치·태그·원격 추적 참조 | 121 | 549 | 15 | 318 |
| HEAD와 전체 로컬 참조 | 374 | 550 | 15 | 319 |

두 범위 모두 커밋 메시지와 UTF-8 블롭에서 지정한 여섯 비밀 패턴이 검출되지 않았다. 경로명에서도 해당 패턴, 이메일 주소 형태, 검사 대상 보관소·DB·환경·키 파일명은 검출되지 않았다. 작성자·커미터 필드의 고유 이메일 중 GitHub 비공개 주소 형식이 아닌 값은 두 범위에서 각각 1개였다. 실제 주소는 기록하지 않았다. 이 결과는 위 시점의 Git 객체에 한하며 공개 동의, 바이너리 내용, 추적되지 않은 파일은 판정하지 않는다.

`acca11c0efb7e3558f3654b2886a7a135fb11807`에서 텍스트 내용 검사를 갱신했다. 검사 전후 HEAD와 로컬 참조 337개가 같았고 참조 목록의 SHA-256은 `bab68c3b791b4fe6bba1ba23737faaec6a3b395b912375ef0db07e78334e8c21`이었다. HEAD와 일반 참조에서는 커밋 메시지 138개와 고유 UTF-8 블롭 569개를, 체크포인트를 포함한 전체 참조에서는 각각 463개와 570개를 검사했다. 여섯 패턴 모두 합성 양성·음성 대조를 통과했고 두 범위 모두 일치 건수는 0이었다. 바이너리 블롭 15개, 경로명, 작성자·커미터 필드는 이번 내용 검사 범위에서 제외했다.

ARM64 대상의 두 Cargo 잠금 그래프를 `cargo tree --offline --locked --target aarch64-apple-darwin`의 `normal` 및 `normal,build` 간선으로 확인했다. 데스크톱 그래프의 MPL 선언은 다섯 건이고 Wasmtime 헬퍼 그래프에는 없었다. 이 목록은 실제 기계어에 포함된 소스 범위와 구분한다. `Athena-m42-arm64-2b65a6a.zip`의 추출본에서 `.wasm` 파일 다섯 개를 확인했다. Athena 실행기용 CPython·QuickJS 외에 Photon, `quickjs-wasi`, Pi의 DOOM 예제가 포함돼 있다. `quickjs-wasi`의 `.so` 확장 다섯 개도 파일 헤더가 WebAssembly임을 확인했다. DOOM 예제의 README는 `doomgeneric`을 출처로 명시하지만 번들에 해당 WASM의 별도 고지는 없다. 출시판에서 사용하지 않는 예제를 빼거나 정확한 소스와 재배포 의무를 확인해야 한다. 세부 목록과 조치는 [제삼자 고지 초안](../../THIRD_PARTY_NOTICES.md)에 기록했다.

후속 점검에서 추적 중인 PNG 14개, ICNS 1개(6개 프레임), PDF 1개(3쪽)를 검사했다. 경로는 16개이며 중복을 빼면 Git 블롭 15개다. `git rev-list --objects HEAD --all`에서 PNG·ICNS·PDF로 분류한 이력상 블롭 15개는 모두 이 집합에 있었다. macOS Vision OCR, ImageIO 메타데이터, PDFKit의 텍스트와 문서 속성을 이메일·홈 경로·대표적인 토큰 형태·개인 키 헤더·비루프백 URL 패턴으로 검사했으며 일치 항목은 없었다. PDF에 작성자 속성이 있으므로 공개 전 실제 값과 재배포 권한은 별도로 확인해야 한다. 이 검사는 OCR 및 메타데이터 추출 범위에 한정되며 번들 전체나 숨은 데이터의 부재를 보증하지 않는다.

공개 전 테스트의 실제 경로·식별자는 예약된 가상 주소나 상대 경로로 교체하고, 시각 자료와 배포 바이너리의 내용 및 재배포 권리를 직접 확인한다. 실사용 값으로 확인되는 후보가 있으면 먼저 폐기·교체한다. 과거 커밋까지 공개할 경우 별도 브랜치 또는 공개용 소스 내보내기 범위를 결정하고 승인된 방식으로 이력을 정리한 뒤 다시 감사한다. 이 브랜치의 이력은 다시 쓰지 않았다. Developer ID, 공증, 깨끗한 별도 Mac의 Gatekeeper 인수와 공개 승인도 아직 없다.

후속 ARM64 빌드 `16f37e2`는 Pi의 DOOM 예제 디렉터리를 스테이징에서 제외하며, 번들 검사도 해당 디렉터리가 남으면 실패한다. 이 변경은 DOOM 예제의 재배포 문제만 제거한다. 다른 WASM과 UI의 고지 및 권리 확인은 남아 있다.

최신 ZIP에서 잠금 파일의 프로덕션 npm 경로 123개와 설치된 `package.json`의 버전을 대조했다. 109개 패키지에서 루트에 라이선스 또는 고지에 해당하는 파일명을 확인했다. 루트 파일이 없는 14개는 Pi 8개, AWS SDK의 `credential-provider-http`·`credential-provider-login`·`nested-clients`, 그리고 `data-uri-to-buffer`·`proxy-agent-negotiate`·`standardwebhooks`다. 패키지 루트만 대상으로 했으므로 중첩 고지나 별도 저작물의 존재 여부는 이 숫자로 판정하지 않는다. Pi 8개의 매니페스트가 모두 같은 저장소와 MIT를 가리켜 [v1.5.2 라이선스 원문](https://raw.githubusercontent.com/earendil-works/pi/v1.5.2/LICENSE)의 [로컬 사본](notices/pi-LICENSE.txt)을 확보했다. 사본은 파일 끝 줄바꿈 한 개를 제외하고 원문과 같다. 현재 앱 ZIP에 새로 삽입하지 않았으며, 배포판을 만들 때 다른 고지와 함께 제공해야 한다.

별도 파일이 없는 패키지를 추가로 대조했다. `data-uri-to-buffer` 4.0.1의 MIT 저작권과 전문은 이미 앱의 패키지 `README.md`에 포함돼 있다. `standardwebhooks` 1.3.0은 npm의 `gitHead`가 가리키는 [배포 커밋의 `libraries/LICENSE`](https://github.com/standard-webhooks/standard-webhooks/blob/daee8284cfe9d4e435ec16e3e68a8f30084d6aaf/libraries/LICENSE)에 MIT 전문이 있다. 같은 커밋의 JavaScript 매니페스트에서 이름과 버전을 확인하고 [고지 사본](notices/standardwebhooks-LICENSE.txt)을 보존했다. 해당 사본은 기존 ZIP에 넣지 않았다.

AWS SDK의 `credential-provider-http` 3.972.86과 `nested-clients` 3.998.3은 [v3.1166.0 배포 커밋](https://github.com/aws/aws-sdk-js-v3/commit/dee2abd898e7d1c69dd5ca5d74ecdce92e47d19d)의 매니페스트와 버전이 일치했고, `credential-provider-login` 3.972.92는 [v3.1167.0 배포 커밋](https://github.com/aws/aws-sdk-js-v3/commit/5b4a724f2ac4006ea5a98c2fed6c629f6845b9bd)과 일치했다. 두 배포 커밋의 저장소 루트 `LICENSE`에는 Apache-2.0 전문과 Amazon 저작권 표시가 있으며, 앱의 `node_modules/@aws-sdk/core/LICENSE`가 그 파일과 바이트 단위로 일치했다. 이 비교는 중첩 의존성 전체의 고지 검사가 아니다. `proxy-agent-negotiate` 1.1.0의 [배포 태그](https://github.com/TooTallNate/proxy-agents/tree/b7e5f7ccce1a3ac5b339cc4c587974e8989cbc16)는 매니페스트에서 MIT를 선언하지만, 해당 패키지나 저장소 루트에서 별도 저작권·라이선스 전문을 확인하지 못했다.

`proxy-agent-negotiate` 1.1.0의 npm 배포 압축 SHA-512는 `package-lock.json`과 일치했고, 패키지 매니페스트와 `dist/`의 파일 네 개는 최신 앱 추출본과 각각 바이트가 같았다. 배포 압축의 다섯 파일을 모두 확인했으나 라이선스 전문이나 저작권 고지는 없었다. 매니페스트의 MIT 선언만으로 고지 사본을 만들지 않는다. 배포 전에 권리자가 제공한 고지를 확보하거나, 고지가 확인된 버전 또는 대체재로 바꾸고 다시 검증한다.

2026-11-21 [npm 배포 목록](https://registry.npmjs.org/proxy-agent-negotiate)에는 `0.0.0`과 `1.1.0`만 있었다. `0.0.0`의 압축 파일도 레지스트리의 SHA-512와 일치했다. 파일 다섯 개 중 별도 고지 파일은 없었고 `copyright`, `Permission is hereby granted`, `SPDX-License-Identifier` 문구도 없었다. 현재 잠금 파일에서 Pi AI가 사용하는 `http-proxy-agent`와 `https-proxy-agent`는 모두 `proxy-agent-negotiate` **1.1.0을 정확히 지정**한다. 따라서 구버전으로 낮추면 고지 문제를 해결하지 못하고 두 패키지의 버전 조건까지 벗어난다. 패키지와 잠금 파일은 변경하지 않았다.

`proxy-agent-negotiate` 1.1.0의 [npm 출처 증명](https://registry.npmjs.org/-/npm/v1/attestations/proxy-agent-negotiate@1.1.0)에서 읽은 산출물 SHA-512는 잠금값 및 내려받은 압축 파일과 일치했다. 증명에 기록된 [커밋 `b7e5f7c`](https://github.com/TooTallNate/proxy-agents/tree/b7e5f7ccce1a3ac5b339cc4c587974e8989cbc16/packages/negotiate)는 [상류 릴리스 태그](https://github.com/TooTallNate/proxy-agents/tree/proxy-agent-negotiate%401.1.0)와 같고, 해당 커밋의 `packages/negotiate/package.json`도 1.1.0과 MIT를 선언한다. 다만 그 커밋의 저장소 루트와 해당 패키지에 라이선스 전문 또는 고지 파일이 없었다. 다른 패키지 디렉터리의 원문은 이 패키지에 적용된다고 확인하지 못했다. npm에 포함된 Sigstore 4.1.1로 SLSA v1 증명의 서명을 검증했다. 새 TUF 캐시를 사용하고 인증서 발급자(`https://token.actions.githubusercontent.com`)와 서명자(`https://github.com/TooTallNate/proxy-agents/.github/workflows/release.yml@refs/heads/main`)를 지정했으며 인증서 투명성 로그와 서명 투명성 로그의 최소 개수를 각각 1로 설정했다. 서명된 패키지 이름·SHA-512·소스 커밋이 위 기록과 일치했다. 산출물 해시를 바꾼 대조 증명은 `TLOG_BODY_ERROR`, 다른 워크플로를 지정한 대조 정책은 `UNTRUSTED_SIGNER_ERROR`로 거부됐다.

npm 레지스트리의 별도 publish v0.1 서명도 확인했다. Sigstore TUF의 `registry.npmjs.org/keys.json`에서 서명 키 ID를 찾았고, 투명성 로그 기록 시점이 키 유효기간 안에 있었다. 이 키로 검증한 배포 증명의 패키지 이름과 SHA-512가 잠금 파일 및 npm 압축 원본과 일치했다. 서명된 대상 목록을 바꾼 대조 증명은 `TLOG_BODY_ERROR`로 거부됐다. 두 서명은 출처와 배포를 확인하는 근거이며, 재배포에 필요한 고지 원문은 여전히 미확인이다.

최신 ARM64 후보의 로컬 납품 폴더에 `Athena-m42-arm64-16f37e2-mpl-source.zip`을 추가했다. MPL-2.0 원문과 출처 목록, 데스크톱 대상 그래프에 나타난 다섯 개의 수정하지 않은 crates.io 소스 아카이브를 담았다. ZIP에서 다시 꺼낸 각 `.crate`의 SHA-256이 `16f37e2`의 `src-tauri/Cargo.lock`과 일치했다. 소스 ZIP의 SHA-256은 `386d95a98f000efee1c8b70d1260a762974739e220598e8acfbd8998efc5035e`다. 외부 배포 전에는 최종 빌드의 범위를 다시 대조하고 수신자에게 해당 소스를 받는 방법을 고지해야 한다. 이 파일은 다른 의존성의 고지를 포함하지 않는다.

최신 ARM64 후보의 `python.wasm`과 `qjs.wasm`에서 WebAssembly 이름 섹션을 읽었다. 두 실행 파일의 wasi-libc, compiler-rt, dlmalloc 함수 이름을 상류 빌드 설정과 대조했고, CPython의 Expat·SHA-2·mimalloc 근거도 확인했다. WASI SDK 29와 33이 각각 고정한 커밋과 동일한 원문 사본을 [WASI 고지 자료](notices/wasi/README.md)에 기록했다. 기존 앱 ZIP은 바꾸지 않았다. 이 확인은 이름이 남은 구성 요소에 한정하며, Photon과 npm `quickjs-wasi`의 WASM 및 확장 파일은 별도 감사 대상으로 남는다.

후속 [Pi WASM 대조](notices/pi-wasm/README.md)에서 `quickjs-wasi` 3.6.2와 Photon 0.3.4의 npm 압축 파일을 잠금 값과 대조했다. 두 패키지의 WASM 일곱 개와 루트 고지 파일은 앱 추출본과 바이트가 같았다. QuickJS-WASI의 배포 출처와 SDK 32·Mbed TLS·Ada를 찾아 고지 원문을 보존했다. Photon은 소스 커밋과 루트 고지를 확인했다. 기존 ZIP은 바꾸지 않았다.

Photon의 같은 소스 커밋에서 배포한 `photon-rs` 0.3.3의 crates.io 압축 파일을 검증해 `Cargo.lock`을 확인했다. 그러나 npm 게시 직전의 상류 `compiled-wasm` 산출물은 앱에 들어 있는 WASM과 크기와 SHA-256이 모두 달랐고, npm 배포의 빌드 증명도 확인되지 않았다. Rust 크레이트의 잠금 파일을 npm 바이너리의 정확한 의존성 목록으로 사용하지 않는다. 출처와 체크섬은 [Pi WASM 대조](notices/pi-wasm/README.md)에 기록했다.

`16f37e2`와 `725e4bc` ZIP의 호스트 리소스 16,128개를 경로와 바이트로 대조했다. 추가·삭제는 없었고 `runtime/agent-tools.ts`만 바뀌었다. 번들 Node와 WASI 헬퍼는 동일했다. 이 비교는 이전 고지 조사의 근거를 이어 주며, 미확인 권리나 고지를 해소하지 않는다. 깨끗한 macOS의 실행·배포 판정은 [릴리스 노트](release-notes.md)에 기록했다.

최신 설치본의 로컬 검토용 고지를 `Athena-m42-arm64-725e4bc-notices-draft.zip`에 모았다. npm 잠금 항목 123개 중 109개의 패키지 루트 고지, 출처를 확인한 보완 고지, 런타임과 UI의 확인된 원문을 담았다. Tauri 2.11.6과 Wasmtime 50.0.3의 원문은 두 `.crate`를 각각 잠금 체크섬과 대조한 뒤 추출했다. ZIP을 다시 풀어 매니페스트와 140개 파일의 경로·크기·SHA-256을 모두 대조했다. ZIP의 SHA-256은 `9708bee04c780341443e47e53c25d62315262d1bbb05481694ce425b93ae144d`다. 앱 ZIP은 바꾸지 않았으며, 별도 MPL 소스 ZIP에 대응하는 데스크톱 잠금 파일도 두 후보에서 같다. 이 초안은 `proxy-agent-negotiate` 원문, Photon 빌드 그래프, 중첩·링크된 구성 요소의 전체 고지, UI와 아트의 재배포 권리를 확정하지 않는다.

`725e4bc`와 Pulley 후보 `a8c26d3`의 ZIP을 따로 풀어 호스트 리소스 16,128개를 경로와 바이트로 대조했다. 바뀐 것은 `analysis-runtime/provenance.json`의 서명 전 도우미 해시뿐이다. Node, npm 파일, Python·QuickJS WASM과 npm·데스크톱·샌드박스 잠금 파일은 같았다. 캐시의 `pulley-interpreter` 및 `pulley-macros` 50.0.3 크레이트 아카이브는 샌드박스 잠금 체크섬과 일치했고, 두 매니페스트는 `Apache-2.0 WITH LLVM-exception`을 선언한다.

Pulley 후보용 고지 초안 `Athena-m42-arm64-a8c26d3-notices-draft.zip`을 별도로 만들었다. npm 123개 버전을 최신 앱 ZIP 및 잠금 파일과 대조했고, 초안에 실린 앱 고지 원문은 해당 ZIP에서 바이트 단위로 확인했다. 매니페스트에 두 Pulley 크레이트의 체크섬, Wasmtime 라이선스 원문 위치, 서명된 분석 도우미의 해시를 기록했다. 다시 추출한 140개 고지·근거 파일의 경로, 크기 및 SHA-256이 매니페스트와 일치했다. 새 고지 ZIP의 SHA-256은 `e5498173f24b252d6bdec86e1f151ec7c9af308cf1f72cefdbcafe8193dd5cef`다. 이전 초안과 앱 ZIP은 유지했다. 최종 릴리스의 네이티브 링크 범위와 전체 고지는 별도로 확인해야 한다.

로컬 Git 작성자 메타데이터도 공개 전에 검토해야 한다. 이번 납품은 기존 Git 설정을 사용하며, 로컬 작성자 정보는 변경하지 않았다.

`fb70cdad66bab27dab12274b4fb970076f0c36c8`에서 도달하는 커밋 127개의 원본 작성자·커미터 이메일 필드를 검사했다. 모든 커밋의 두 필드에 같은 `.local` 호스트 주소가 있었다. M4.1 기준 이후 이 브랜치에 추가된 86개 커밋만 검사해도 결과가 같다. 파일에서 개인 정보를 지우더라도 이력을 그대로 공개하면 이 주소가 노출된다. 실제 값은 기록하지 않았다. 기존 이력 공개 여부는 별도 결정 사항이며, 이 결과로 이력 재작성이나 공개가 승인된 것은 아니다.

`acca11c..c21e65f`에 추가된 커밋 6개에서도 작성자·커미터 이메일 필드 12개가 모두 `.local` 주소였다. 두 커밋 사이의 이메일 필드만 집계했으며, 이 구간을 포함해 브랜치를 공개하면 해당 주소도 공개된다.

`a8c26d3` ZIP 자체에서 ARM64 실행 파일 세 개와 Pi의 `darwin-arm64/darwin-platform.node`를 추출해 `otool -L`, `otool -l`, `vtool -show-build`로 읽었다. 네 파일의 직접 동적 링크 참조는 모두 macOS가 제공하는 `/System/Library/Frameworks`와 `/usr/lib` 아래였고 `LC_RPATH`는 없었다. 표시된 최소 macOS 버전은 앱과 Node가 13.5, 분석 도우미와 Pi ARM64 모듈이 11.0이었다. 이 값은 Mach-O의 배포 대상이며 13.5에서의 실행 시험 결과는 아니다.

ZIP에는 별도 `.dylib` 파일이 없었고 Pi의 `.node` 모듈이 6개 있었다. macOS ARM64 외에 macOS x64, Linux ARM64/x64, Windows ARM64/x64 모듈도 들어 있다. 실행 파일 옆의 `._` 항목 세 개는 AppleDouble 헤더를 확인했으며 실행 파일로 세지 않았다. 이 검사는 네 ARM64 파일의 직접 동적 링크만 확인했다. 미사용 플랫폼 모듈의 배포 고지, 정적으로 링크한 코드, 실행 중 동적 로드하는 구성 요소의 범위는 별도로 검토해야 한다.

같은 ZIP의 중앙 디렉터리와 로컬 헤더 35,321쌍을 검사했다. 중복 경로와 ZIP·개별 항목 주석은 없었고, 추가 필드는 Info-ZIP Unix `0x5855` 한 종류였다. 대응하는 원본 경로가 있는 AppleDouble 항목 17,660개에는 모두 `com.apple.provenance` 속성 하나가 있었다. AppleDouble 안의 리소스 포크는 모두 비어 있었고 FinderInfo에는 0 이외의 값이 없었다. 검사 결과에는 속성값이나 로컬 계정 식별자를 기록하지 않았다. 원본 ZIP은 변경하지 않았으며, 이 결과는 최종 배포판의 메타데이터나 다운로드 뒤 OS가 부여하는 격리 속성을 판정하지 않는다.

### 최신 앱 ZIP의 사용자 데이터 검사

`7f62be5` ZIP의 SHA-256을 대조한 뒤 `Info.plist`와 ARM64 Mach-O 네 개를 읽었다. `LSMinimumSystemVersion`은 13.5였고 `LC_BUILD_VERSION`의 최소 macOS는 `athena-desktop`과 `athena-node`가 13.5.0, `athena-sandbox`와 `darwin-platform.node`가 11.0.0이었다. 네 파일 모두 앱이 선언한 최소 버전 이하를 대상으로 빌드됐다. macOS 13.5에서의 실행 여부는 미검증이다.

`7f62be5` Keychain 수정본과 `a8c26d3` 기능 기준본의 ZIP 체크섬을 확인하고, 디렉터리와 AppleDouble을 제외한 앱 내부 파일을 경로와 SHA-256으로 대조했다. 두 ZIP 모두 16,134개 파일을 담고 있으며 추가·삭제된 경로는 없다. `node_modules` 아래 15,499개 파일은 모두 바이트가 같아 기존 npm 고지 검토와 같은 입력을 사용한다. 내용이 달라진 네 파일은 `athena-desktop`, `athena-sandbox`, `analysis-runtime/provenance.json`, `_CodeSignature/CodeResources`다. 출처 JSON에서 값이 바뀐 항목은 `files.athena-sandbox`뿐이었다. 이 비교로 미해결 재배포 권리가 확정되지는 않는다.

`c13aa51-remap-022`의 압축을 푼 앱에 대해 **호스트 실행 정책 및 배포 평가 — FAIL**. `spctl --assess --type execute -vv`는 `rejected`로 종료했다(코드 `3`). `syspolicy_check distribution`은 공증 티켓 누락을 보고했다(코드 `70`). 앞서 통과한 엄격한 서명 검사는 앱 봉인의 무결성을 확인한 것이다. 이 두 정책 평가는 게스트의 Finder를 실행하지 않았다.

**수정 검토본 — ZIP 권한·지정 경로·앱 봉인 PASS.** `c13aa51` 소스를 비공개 작업 디렉터리에서 경로 치환과 `umask 022`로 다시 빌드했다. `Athena-m42-arm64-c13aa51-remap-022-review.zip`의 항목 36,849개에서 지정 홈·소스 경로는 발견되지 않았다. 앱 디렉터리의 읽기·탐색, 리소스의 읽기, 소유자가 실행할 수 있는 파일을 다른 사용자도 실행할 수 있는지 검사해 권한 위반 0건을 확인했다. 별도 디렉터리에 압축을 푼 앱이 `codesign --verify --deep --strict`를 통과했다. ZIP SHA-256은 `8c2d7e066e36d63aa905ac418109fc9113aadbc7556ade8a3afce3c7acf2c3ea`다. 이 결과는 다른 계정에서의 Finder 실행이나 공증 인수가 아니다.

**공유 설치용 권한 검사 — FAIL (첫 경로 치환 검토본).** 체크섬을 확인한 `a8c26d3`와 `c13aa51-remap-review`의 앱 파일 16,134개를 같은 경로끼리 비교했다(AppleDouble 제외). 내용이 바뀐 것은 `athena-desktop`, `athena-sandbox`, 분석 도우미 해시를 기록한 `provenance.json`, 서명 리소스 `CodeResources` 네 개다. 한편 일반 파일 15,517개의 모드가 `0644`에서 `0600`으로, 실행 파일 21개가 `0755`에서 `0700`으로 바뀌었다. 앱 루트와 `Contents/MacOS`도 `0700`이었다. 이 검토본으로 다른 macOS 사용자가 읽거나 실행할 수 있는 공유 설치를 인수하지 않는다. 빌드 디렉터리는 비공개로 유지하되 번들은 `umask 022`로 새로 빌드한다.

별도 **경로 치환 검토본 — 지정 경로 검사 PASS**. `c13aa51`의 추적 소스를 깨끗한 디렉터리에서 [경로 치환 옵션](../development.md)으로 빌드했다. 빌드 과정에서 번들 Python·JavaScript 산출물, 키 전달 중단과 보관소 보존, 재시작 후 통제된 Pi 스트리밍·도구 호출을 확인했다. `Athena-m42-arm64-c13aa51-remap-review.zip`의 파일명 및 압축 해제한 파일 항목 33,794개에서 빌드 계정 홈과 임시 소스 디렉터리 접두어는 0건이었다. 이 ZIP을 다시 풀어 엄격한 코드 서명 검사를 통과했다. SHA-256은 `fe0afe430c530b23432c2c9f9926f366f4adc2bd586ea66aaac31f82642c761c`다. 이 검토본에는 기존 후보의 실제 Qwen·VM 인수 결과를 적용하지 않는다.

**개인 빌드 경로 검사 — FAIL (`a8c26d3`, 외부 배포 보류).** ZIP 체크섬을 확인한 뒤 파일명과 디렉터리 이외의 항목 33,794개의 압축 해제 바이트에서 빌드 계정 홈 디렉터리의 절대 경로 접두어를 검사했다. 파일명에서는 발견되지 않았지만 `athena-desktop`에서 370회, `athena-sandbox`에서 562회 발견했다. 다른 항목에서는 같은 접두어가 없었다. 실제 계정명과 경로는 기록하지 않았다. 두 Rust 실행 파일을 경로 치환을 적용해 다시 빌드하고, 배포할 ZIP에서도 같은 검사를 통과해야 한다. 서명이나 공증만으로 바이너리 안의 경로가 지워지지는 않는다.

`Athena-m42-arm64-a8c26d3.zip`의 SHA-256이 `06c3e5153f2bc25f6ebe1a69023e37c650aa171250a204b3da39f5a7cec2514d`와 일치했다. 디렉터리 1,527개와 위에서 별도로 감사한 AppleDouble 17,660개를 제외하고, 파일 항목 16,134개(UTF-8 16,101개, 바이너리 33개)의 이름과 원본 바이트 316,141,093바이트를 읽기 전용으로 검사했다. 지정한 Athena 보관소·DB, 자격 증명, 세션 JSONL, 일반 DB 파일명 패턴과 SQLite 파일 헤더는 검출되지 않았다.

개인 키 헤더, 제공자 토큰 및 JWT 형태를 검사한 결과 AWS 접근 키 형태가 `@aws-sdk/nested-clients` 3.998.3의 STS 선언 파일 두 개에서 각각 한 번 나왔다. 두 값은 알려진 AWS 문서 예시였고, 두 파일은 잠금 파일의 SHA-512와 일치한 npm 원본의 해당 파일과 바이트가 같았다. 그 외 패턴은 검출되지 않았다. 각 자격 증명·경로 규칙은 합성 표본으로 확인했고, 후보 값은 출력하지 않았다.

이 검사는 이름과 ZIP을 푼 바이트에 대한 패턴 검사다. 다른 이름으로 저장된 암호화 자료, 디코딩하지 않은 바이너리 내부 데이터, 미등록 비밀 형식, 최종 서명본의 내용까지 보증하지 않는다. 최종 배포 ZIP에서도 같은 범위를 다시 확인한다.

## ARM64 Rust 고지 원본

`a8c26d3` 이후 변경되지 않은 두 Cargo 매니페스트와 잠금 파일에서 `cargo tree --offline --locked --target aarch64-apple-darwin`으로 그래프를 확인했다. Athena 자체 패키지를 제외하고 이름·버전으로 중복을 제거했다. 합집합의 crates.io 아카이브 **319개 모두** 해당 잠금 파일의 SHA-256과 일치했다. 압축 원본에서 `LICENSE`, `COPYING`, `COPYRIGHT`, `NOTICE`, `UNLICENSE` 계열 이름으로 루트 고지 후보를 찾았다.

| 그래프 | 크레이트 | 루트 고지 후보 | 루트 후보 없음 |
|---|---:|---:|---:|
| 데스크톱 `normal` | 227 | 211 | 16 |
| 분석 도우미 `normal` | 147 | 135 | 12 |
| 데스크톱 `normal,build` | 243 | 226 | 17 |
| 분석 도우미 `normal,build` | 156 | 141 | 15 |
| 네 그래프 합집합 | 319 | 287 | 32 |

루트 후보가 없는 32개에서 `.cargo_vcs_info.json`의 커밋을 확인했다. 그중 `objc2-foundation`의 중첩 `copying.rs` 두 개는 파일명 검색에 걸렸지만 고지 파일이 아니다. 나머지 31개에서는 중첩 경로에서도 해당 파일명 후보가 없었다. 루트 후보가 있다는 사실만으로 모든 고지 의무가 충족된 것으로 보지 않는다.

| 루트 후보가 없는 크레이트 | 상류에서 찾은 자료 |
|---|---|
| Wasmtime·Cranelift·Pulley 14개, `wast` 1개 | 해당 [Wasmtime 커밋의 LICENSE](https://github.com/bytecodealliance/wasmtime/blob/9bbe3e2f859a0d67af6a51e614b77a4b97cdc907/LICENSE)와 [`wast`가 가리키는 wasm-tools 커밋의 LICENSE](https://github.com/bytecodealliance/wasm-tools/blob/61b23615e3784c6e1aad8904e3832bb55ce9356e/LICENSE)는 바이트가 같고 LLVM 예외를 포함한다. SHA-256 `268872b9816f90fd8e85db5a28d33f8150ebb8dd016653fb39ef1f94f2686bc5`. |
| `objc2` 계열 9개 | 다섯 상류 커밋의 `LICENSE.md`가 [프레임워크 크레이트 출처의 파일](https://github.com/madsmtm/objc2/blob/7b1abfd750a2cacaea71d6a56ecfb83cb7de560b/LICENSE.md)과 바이트가 같았다. SHA-256 `7f976f7e9cb2d87df7230606feb932c3f21ac0e664045a775b600046ff850c54`. 이 파일은 라이선스 전문을 참조하고 Xcode SDK에서 파생된 바인딩의 재배포 조건에 관한 불확실성을 명시한다. 전문과 적용 범위를 별도로 검토한다. |
| `unic-*` 5개 | [공통 상류 커밋](https://github.com/open-i18n/rust-unic/tree/5878605364af97a3358368a6eaef02104af2e016)과 [`unic-ucd-ident` 커밋](https://github.com/open-i18n/rust-unic/tree/8a6ce83063d90b91ae2ce59eddb803edd393fca9)에서 각각 `LICENSE-APACHE`와 `LICENSE-MIT`를 확인했다. 두 커밋에서 각 원문은 바이트가 같았다. |
| `alloc-stdlib` | [출처 커밋의 BSD-3-Clause 원문](https://github.com/dropbox/rust-alloc-no-stdlib/blob/ae42d22078b98549e987d2f03d12df7b984fde47/LICENSE)에 Dropbox 저작권 고지가 있다. |
| `tauri-plugin` | [출처 커밋](https://github.com/tauri-apps/tauri/tree/6f6ab1207bb3923c2721fbc67d2fdb1c8deb0c7a)의 `LICENSE_APACHE-2.0`과 `LICENSE_MIT`를 확인했다. |
| `selectors` | [출처 커밋의 `selectors/lib.rs`](https://github.com/servo/stylo/blob/635e1a19d02960588a00e189bd4bd5bdb150ec3d/selectors/lib.rs)는 MPL-2.0을 명시한다. 잠금값과 일치하는 이 크레이트 원본과 MPL 전문은 위의 소스 ZIP에 들어 있다. |

위 표는 확인한 출처를 기록한다. 정적 링크와 생성 코드의 실제 포함 범위, 추가 저작물의 고지, Xcode SDK 파생 바인딩의 배포 조건은 공개 전에 검토해야 한다. 기존 앱·고지 ZIP은 변경하지 않았다.

`objc2` 계열은 Rust 고지 ZIP 매니페스트에 기록된 상류 커밋 다섯 개의 전체 트리를 확인했다. 고지 계열 파일명으로 찾은 문서는 공통 `LICENSE.md` 한 개였으며, 이 문서는 MIT·Zlib·Apache-2.0 전문의 외부 링크와 [재라이선스 이슈](https://github.com/madsmtm/objc2/issues/23)를 가리킨다. 이슈는 조사 시점에 열린 상태였다. 잠금값과 일치하는 `.crate` 원본 9개의 선언은 MIT 4개와 `Zlib OR Apache-2.0 OR MIT` 5개였다. 이 선언이나 외부 전문 링크만으로 패키지별 저작권 고지의 충족 여부를 판단하지 않는다.

같은 아카이브에는 생성 표기가 있는 `src/generated/` 아래 Rust 소스가 `dispatch2` 1개, `objc2-app-kit` 294개, `objc2-core-foundation` 46개, `objc2-foundation` 171개, `objc2-web-kit` 215개 있었다. 나머지 네 아카이브에는 이 경로 아래 Rust 소스가 없었다. 이 수치는 소스 아카이브 기준이며, 해당 파일이 앱에 링크됐거나 개별 파일의 재배포 권한이 확인됐다는 뜻은 아니다. 공개 전에는 패키지별 고지 원문과 관련 [Apple SDK 조건](https://www.apple.com/legal/sla/docs/xcode.pdf)을 확인한다.

검토 자료 `Athena-m42-arm64-a8c26d3-rust-notices-review.zip`을 로컬 납품 폴더에 추가했다. 매니페스트에는 Cargo 잠금 파일 두 개의 SHA-256, 크레이트 319개의 체크섬과 그래프별 라이선스 선언, 상류 출처 14개가 들어 있다. ZIP에는 원본 크레이트의 루트 고지 후보 529개, 서로 다른 상류 파일 7개, MPL-2.0 전문과 설명을 담았다. 다시 열어 539개 항목을 확인했고 매니페스트가 가리키는 각 파일의 크기와 SHA-256이 일치했다. ZIP SHA-256은 `9ee437385bcaa35c4f7e6bab61935b7ccaba5fb5f02e6ca5bfdfe087b472e53d`다. 이 보충 자료는 최종 배포 고지나 정적 링크 목록이 아니다.
