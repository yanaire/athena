# Athena — 대화 중심 데스크톱 UI

Codex처럼 대화를 중심에 두고, 연구 결과·워크플로우·원고를 오른쪽에서 접고 펼치는 Athena UI 시안입니다. 첨부 DESIGN.md의 따뜻한 아이보리·화이트·테라코타 색상 참고를 앱 밀도에 맞게 적용했습니다. 실제 사용 글꼴은 Noto Sans CJK KR과 시스템 폴백이며, Anthropic 전용 글꼴을 사용한 것으로 표시하지 않습니다.

## 화면

- `01-conversation-collapsed.svg`: 연구 패널을 닫은 기본 대화.
- `02-results-sidebar-open.svg`: 결과와 원본 근거를 여는 오른쪽 패널.
- `03-manuscript-sidebar-open.svg`: 원고를 여는 오른쪽 패널.
- `04-workflow-sidebar-open.svg`: 연구 진행과 실행 상태를 여는 오른쪽 패널.

모든 화면은 1440 × 960입니다. 왼쪽 프로젝트·스레드 탐색은 240px, 열린 오른쪽 패널은 420px입니다. 중앙 대화는 최대 760px이며 연구 패널을 닫으면 대화 공간이 넓어집니다. 중앙의 상단 탭은 없고, 오른쪽 패널 안에만 `워크플로우 | 결과 | 원고` 탭이 있습니다.

연구 수치·진행 상태·프로그램 연결·원고는 디자인을 설명하는 예시입니다. 실제 계산 결과가 아닙니다.

## 파일 확인

- `../athena-preview.html`: 브라우저에서 여는 HTML 프로토타입.
- `svg/`: 텍스트와 도형으로 직접 작성한 벡터 UI.
- `athena-design.json`: 편집용 화면·색상·텍스트·벡터 데이터.
- `figma-import/`: 네이티브 Figma 레이어 생성용 개발 플러그인 코드.

HTML과 벡터는 별도 산출물입니다. 벡터를 브라우저 DOM이나 스크린샷에서 자동 추출한 것은 아니며, 동일한 디자인 방향과 콘텐츠로 직접 작성했습니다. 세부 간격은 다를 수 있습니다.

## Figma로 가져오기

가장 빠른 방법은 `svg/`의 화면을 Figma Design 캔버스로 끌어오는 것입니다. SVG 원본은 실제 텍스트와 벡터를 포함하지만, Figma가 글꼴을 대체하거나 글자를 윤곽선으로 변환할 수 있습니다.

별도 텍스트 레이어를 유지하려면 다음 개발 플러그인 방법을 사용할 수 있습니다.

1. Figma 데스크톱 앱에서 새 개발 플러그인을 만듭니다.
2. Figma가 발급한 ID가 있는 `manifest.json`을 유지합니다.
3. 생성된 `code.js`를 이 키트의 `figma-import/code.js`로 교체합니다.
4. `manifest.settings.json`의 `main`, `api`, `editorType`, `documentAccess`, `networkAccess` 설정을 반영합니다. 이 파일은 Figma ID가 빠진 설정 참고 파일이며 단독 완성 manifest가 아닙니다.
5. 원하는 Design 파일에서 실행합니다.

플러그인은 새 `Athena · Conversation UI` 페이지를 추가하고 기존 페이지는 유지합니다. 네트워크 요청을 하지 않습니다. 실제 Figma 내부 실행은 현재 세션에서 검증하지 못했습니다.

Noto Sans KR, Noto Sans CJK KR 등 한글 글꼴을 사전 확인하며, 한글 글꼴이 없으면 캔버스를 바꾸기 전에 중단합니다. 원본 글꼴 우선, 영문 대체 후보 Inter를 사용합니다. 사용 가능한 글꼴에 따라 세부 폭이나 줄 간격을 조정할 수 있습니다.

Figma로 가져온 화면은 고정 배치의 편집 가능한 디자인이며, HTML에서 구현한 패널 열기·닫기 동작이 자동으로 Figma 프로토타입에 연결되지는 않습니다.

## 검증 범위

SVG XML, 벡터·텍스트 구성, 파일 크기, 코드 구문을 검사하고 Inkscape로 PNG를 생성해 확인했습니다. 브라우저 실행 및 Figma 내부 가져오기 성공을 주장하지 않습니다.

Lucide 아이콘을 사용했으며 `../vendor/LICENSE-LUCIDE.txt`의 라이선스를 함께 보존해 주세요.
