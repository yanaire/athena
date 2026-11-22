# Athena M4 macOS 데스크톱

Apple Silicon macOS 13.5 이상에서 `Athena.app`을 Finder로 연다. 앱에 Node.js 24.22.3과 Pi 1.5.2가 포함된다. 사용자가 Node 또는 npm을 따로 설치할 필요는 없다. 모델 서버나 API 제공자는 기존 프로필에 지정한다. 앱은 모델 가중치나 자격 증명을 배포하지 않는다.

빌드하는 Mac에는 Xcode Command Line Tools, Rust와 Node 24가 필요하다. 저장소 루트에서 `npm ci` 다음 `npm run desktop:build`를 실행한다. 산출물은 `src-tauri/target/aarch64-apple-darwin/release/bundle/macos/Athena.app`이다. 빌드가 정해진 해시의 upstream Node arm64 바이너리와 잠금 파일의 실행 의존성을 포장하고, 완성된 번들의 실행 파일로 인증된 HTTP 부트스트랩을 확인한다.

[Finder 실실행과 개발 회귀 검사 기록](verification.md)을 참고한다.

이 문서의 초기 키체인 동작은 M4 기준이다. 현재 M4.1에서는 [키체인과 제공자 로그인 운영 안내](../m41/native-auth.md)가 이 절의 동작을 대체한다.

## 저장소와 로그인 키체인

기본 작업공간은 기존 호스트와 같은 `~/.athena/workspace`다. 이전에 별도 `ATHENA_DATA_DIR`로 실행했다면 다시 같은 절대 경로를 지정한다. 저장된 Pi 세션은 프로젝트의 실제 경로를 확인하므로, 작업공간을 다른 경로에 단순 복사하는 것은 데이터 이전 절차가 아니다. 앱과 브라우저 호스트가 같은 작업공간을 동시에 열 수 없다.

앱은 `Athena provider vault v1` 서비스에서 작업공간의 실제 경로에 해당하는 키를 찾는다. 로그인 키체인을 읽고 쓸 수 있으면 새 작업공간에 키를 초기화한다. 시작할 때 macOS 암호 창을 띄우지 않는다. 키체인이 잠겨 있고 기존 암호화 보관소가 없으면 모델 프로필과 키 없는 모델을 사용할 수 있으며, 새 자격 증명은 메모리에만 남는다. 설정의 `Memory only` 표시를 확인한다. 다음 시작 전에 macOS 키체인 접근 앱에서 로그인 키체인을 열 수 있다. 기존 암호화 보관소가 있다면 정확한 키 없이는 열지 않고 기존 파일도 바꾸지 않는다. 운영자가 관리하던 원래 키는 지원되는 `ATHENA_CREDENTIAL_KEY`로 제공한다. 암호와 키는 화면 캡처나 진단 기록에 넣지 않는다.

## 실행과 보안 경계

Tauri가 번들의 `Contents/MacOS/athena-node`를 실행한다. Node가 작업공간을 잠근 뒤, Rust가 임의로 생성한 일회용 세션 토큰과 필요한 보관소 키를 파이프로 넘긴다. Node가 운영체제에서 배정받은 `127.0.0.1` 포트의 준비 신호를 보내면 WKWebView가 기존 Athena HTML에 접속한다. 인증은 비영속 WebView에 넣은 `HttpOnly` 쿠키를 사용한다. RPC, SSE, HTML과 결과 파일이 모두 인증 대상이다. 기본 출처 검사와 CSP, 외부 탐색·팝업 차단으로 다른 웹페이지와 로컬 포트에 기능을 노출하지 않는다. WebView에는 Tauri 명령 권한을 주지 않는다. 이 경계는 다른 로컬 앱의 임의 HTTP 접근을 막으며, 같은 macOS 계정에서 작업공간 파일 자체를 읽을 권한이 있는 프로세스를 격리하지는 않는다.

창을 닫거나 앱을 종료하면 파이프가 닫혀 Node가 연결을 닫고 작업을 정리한다. 강제 종료로 남은 미완료 시도는 다음 실행에서 기존 TaskManager가 중단 상태로 복원하며 자동 재실행하지 않는다. 이전의 SQLite, Pi JSONL과 결과 파일은 앱 번들 밖에 둔다.

## 제공자, 분석 실행기, 배포

기존 모델 프로필과 API 키 경로를 사용한다. [M3.1의 ChatGPT 플랜 로그인·독립 Codex OAuth와 Pending 7개](../m31/chatgpt-codex.md)는 그대로다. Docker는 일반 모델, 위임, 파일 읽기와 고정 CSV 계산의 조건이 아니다. 모델이 작성한 Node/Python 분석을 실행하려면 Docker CLI와 로컬 데몬, 고정 이미지, 프로젝트 옵트인이 필요하다. Settings의 **Agents & execution**에서 호스트 정책과 비가용 사유를 확인할 수 있다. [M4.1 교체 설계](docker-free.md)는 별도다.

Node 배포본의 라이선스와 번들 의존성 고지문은 `Contents/Resources/host/licenses/node-LICENSE.txt`, npm 패키지의 고지문은 각 패키지 디렉터리에 있다. Node 다운로드 해시와 npm 잠금 파일 해시는 `Contents/Resources/host/provenance.json`에 있다. Tauri와 플러그인은 MIT 또는 Apache-2.0, Security.framework 바인딩은 MIT 또는 Apache-2.0이다. 번들에 대한 로컬 ad-hoc 서명은 개발 Mac에서 무결성 확인을 위한 것이다. 외부 배포용 Developer ID 서명과 공증은 별도의 배포 인증이 필요하다.
