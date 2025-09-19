@echo off

REM ���� https_proxy ��������ʹ�ñ��ص�socks5��http(s)����
REM ʹ�� HTTP ����export https_proxy=http://127.0.0.1:7890
REM ����֤��SOCKS5����
REM export https_proxy="socks5://username:password@127.0.0.1:1080"
REM ������֤��SOCKS5����
REM export https_proxy="socks5://127.0.0.1:1080"
REM HTTP����
REM export https_proxy="http://username:password@127.0.0.1:8080"
set http_proxy=
set https_proxy=

REM ��װ������
call npm install

REM ���ô������վ��you��perplexity��happyapi
set ACTIVE_PROVIDER=you

REM ����ָ�������,������ 'chromium', 'chrome', 'edge' �� 'auto'
set BROWSER_TYPE=auto

REM �����Ƿ��Զ�����chromium
set AUTO_DOWNLOAD_CHROMIUM=false

REM �����Ƿ������ֶ���¼
set USE_MANUAL_LOGIN=false

REM �����Ƿ���������� (���������ʵ���ϴ�ʱ����������Ϊtrue) (ֻ����`USE_MANUAL_LOGIN=false`ʱ����Ч)
set HEADLESS_BROWSER=true

REM �Ƿ�ʹ�ùܵ��������WebSocket���� (chrome)
set USE_PIPE_TRANSPORT=true

REM �Ƿ���Cookie�־�ģʽ (���ֶ���¼�¶�cookie��Ҫ���������ʵ������)
set COOKIE_PERSISTENCE_MODE=false

REM �������������ʵ������(�ǲ��������£���������1)
set BROWSER_INSTANCE_COUNT=1

REM -----��������ʼ-----
REM TLS�ֻ������Сʱ��
set TLS_ROTATION_INTERVAL=2
REM �Ƿ����TLS�ֻ����
set TLS_RANDOMIZE_INTERVAL=true
REM �Ƿ�����ָ���ֻ�
set ENABLE_FINGERPRINT_ROTATION=true
REM ָ���ֻ������Сʱ��
set FINGERPRINT_ROTATION_INTERVAL=6
REM �Ƿ���ģ�������ʷ(��������,�����������ӳ�)
set ENABLE_FAKE_HISTORY=false
REM ǿ�ƶ��˺�ģʽ (����Cookie�־�ģʽʱʧЧ)
set FORCE_MULTI_SESSION_MODE=true
REM ��ȡconfig.mjs, cookieģʽʹ�����UUID
set FORCE_REGEN_UUID=true
REM ����ǿ�ƹ̶���һ�仰
set FORCE_FILE_UPLOAD_QUERY=true
REM �Ƿ���������ģʽ
set INCOGNITO_MODE=true
REM ---------------------------------------------------
REM �����Ƿ��ڿ�ͷ��������
set ENABLE_GARBLED_START=false
REM ���ÿ�ͷ����������С����
set GARBLED_START_MIN_LENGTH=1000
REM ���ÿ�ͷ����������󳤶�
set GARBLED_START_MAX_LENGTH=5000
REM ���ý�β��������̶�����
set GARBLED_END_LENGTH=500
REM �����Ƿ��ڽ�β��������
set ENABLE_GARBLED_END=false
REM ---------------------------------------------------
REM -----����������-----

REM ========== YouChat �������� ==========
REM ���ù����������û����� - ����AI�Զ����ɺͽ�������ִ������
REM true: ���ù��������ɣ�����������ֽ�Ϊ�������
REM false: ���ù��������ɣ�ʹ�ô�ͳ�ʴ�ģʽ (�������think, ��`ENABLE_THINKING_CHAIN`����)
set ENABLE_WORKFLOW_GENERATION_UX=true
REM ���ÿ���<think>����˼������
set ENABLE_THINKING_CHAIN=true
REM ���ø��Ի���ȡ - ���û���ʷ�Ի���ѧϰƫ�ú�ϰ��
REM true: �����û�������Ի��ش����ݺͷ��
REM false: ʹ�ñ�׼���ش𣬲����и��Ի�����
set USE_PERSONALIZATION_EXTRACTION=false
REM ���ÿɱ༭������ - �����û��޸�AI���ɵĹ���������
REM true: �û����Ա༭����ӡ�ɾ���������ڵ�
REM false: ������ֻ�����û��޷��޸�
set ENABLE_EDITABLE_WORKFLOW=true
REM ʹ��Ƕ��ʽ������� - ����������Ϣ����ʾ����֯��ʽ
REM true: ʹ��Ƕ�׽ṹ��ʾ��Ϣ����״�ṹ��
REM false: ʹ��ƽ��ʽ��Ϣ��ʾ�����Խṹ��
set USE_NESTED_YOUCHAT_UPDATES=false
REM ����������������� - AI����ѯ��ģ���������ϸ��Ϣ
REM true: �����ⲻ��ȷʱ��AI�����������������
REM false: AIֱ�ӻ���������Ϣ�ش𣬲���������
set ENABLE_AGENT_CLARIFICATION_QUESTIONS=false
REM ========== YouChat �������ý��� ==========
REM ========== ������ṹ����(�������ƽ̨������ṹ) ==========
REM �Ƿ�����������ṹ����
set DEBUG_REQUESTS=false
REM �Ƿ���ʾ��������
set DEBUG_VERBOSE=false
REM ========== ������ṹ���Խ��� ==========

REM -----�ڴ��Զ�����������-----
REM �����ʱ��(��λ: ����)
set MEMORY_CHECK_INTERVAL=60
REM �ڴ�������ֵ, �������ò����ʵ�����(��λ: MB)
set HEAP_WARNING_THRESHOLD=8192
REM ���ôﵽָ���ڴ���ֵ�Զ�����
set AUTO_GC_ON_HIGH_MEMORY=false

REM -----�����������-----
REM �Ƿ�����������Զ��������(���������ر�/�쳣ʱ�Զ�����)
set ENABLE_HEALTH_CHECK=false
REM ���������(����)
set HEALTH_CHECK_INTERVAL=10
REM ����ǰִ�н������
set HEALTH_CHECK_BEFORE_LOCK=true

REM �����Զ���ȡģ���б��ϣֵ
REM ��ȡ����: you.comҳ��, ��f12���л�'����(network)', ����ѡ��һ��ģ�ͷ��������ڵ�4��(�ļ� file)
REM �ҵ�����: `_next/data/`��ͷ: `_next/data/0eae4547518d0f954439be9efdaae87c915b8921/en-US/search.json?q...`��ַ (����������ɸѡ)
REM ��`0eae4547518d0f954439be9efdaae87c915b8921`����`YOU_BUILD_HASH`��ע�ⲻҪ�пո�
set YOU_BUILD_HASH=

REM ���ûỰ�Զ��ͷ�ʱ��(��λ:��) (0=�����Զ��ͷ�)
set SESSION_LOCK_TIMEOUT=180

REM �����Ƿ����ò�������
set ENABLE_DETECTION=true

REM �����Ƿ������Զ�Cookie���� (USE_MANUAL_LOGIN=falseʱ��Ч)
set ENABLE_AUTO_COOKIE_UPDATE=false

REM �Ƿ������˻���֤ (����ʱ��`ALLOW_NON_PRO`������Ч���������˺��������)
set SKIP_ACCOUNT_VALIDATION=false

REM ���������������(Ĭ������3������) (��������˻�)
set ENABLE_REQUEST_LIMIT=false

REM �Ƿ������Pro�˻�
set ALLOW_NON_PRO=false

REM �����Զ�����ֹ��(���ڴ������ͣ��������������������ã�ʹ��˫���Ű���)
set CUSTOM_END_MARKER="<CHAR_turn>"

REM �����Ƿ������ӳٷ��������������false�����������Դ���
set ENABLE_DELAY_LOGIC=false

REM �����Ƿ������������
set ENABLE_TUNNEL=false

REM ����������� (localtunnel �� ngrok)
set TUNNEL_TYPE=ngrok

REM ����localtunnel������(������Ϊ�������)
set SUBDOMAIN=

REM ========== ���� ngrok AUTH TOKEN ==========
REM ���� ngrok �˻��������֤���ơ������� ngrok �Ǳ��� "Auth" �����ҵ�����
REM ����˻��͸����˻�����Ҫ���ô��
REM ngrok��վ: https://dashboard.ngrok.com
set NGROK_AUTH_TOKEN=

REM ���� ngrok �Զ�������
REM ������ʹ���Լ������������� ngrok �������������
REM ע�⣺�˹��ܽ������� ngrok �����˻���
REM ʹ�ô˹���ǰ����ȷ������ ngrok �Ǳ������Ӳ���֤�˸�������
REM ��ʽʾ����your-custom-domain.com
REM ���ʹ������˻�����ʹ���Զ����������뽫�������ա�
REM ���� ngrok �Զ�������
set NGROK_CUSTOM_DOMAIN=
REM ���� ngrok ������
set NGROK_SUBDOMAIN=
REM ����ѡ��: us (����), eu (ŷ��), ap (��̫), au (�Ĵ�����), sa (����), jp (�ձ�), in (ӡ��)
set NGROK_REGION=jp
REM ���ý������
set NGROK_HEALTH_CHECK=false
REM ���������(����)
set NGROK_HEALTH_INTERVAL=60000
REM ������Դ���
set NGROK_MAX_RETRIES=2
REM ��������ַ
set NGROK_WEB_ADDR=127.0.0.1:4040
REM ǿ��TLS
set NGROK_BIND_TLS=true
REM ========== ���� ngrok AUTH TOKEN ���� ==========

REM ���� PASSWORD API����
set PASSWORD=

REM ���� PORT �˿�
set PORT=8080

REM ����AIģ��(Claudeϵ��ģ��ֱ���ھƹ���ѡ�񼴿�ʹ�ã��޸�`AI_MODEL`�������������л�Claude�����ģ�ͣ�֧�ֵ�ģ���������� (��ο�������ȡ����ģ��))
set AI_MODEL=

REM �Զ���Ựģʽ
set USE_CUSTOM_MODE=false

REM ����ģʽ�ֻ�
REM ֻ�е� USE_CUSTOM_MODE �� ENABLE_MODE_ROTATION ������Ϊ true ʱ���Ż�����ģʽ�ֻ����ܡ�
REM �������Զ���ģʽ��Ĭ��ģʽ֮�䶯̬�л�
set ENABLE_MODE_ROTATION=false

REM ����α����role (������ã�����ʹ��txt��ʽ�ϴ�)
set USE_BACKSPACE_PREFIX=false

REM �����ϴ��ļ���ʽ docx | txt | json
set UPLOAD_FILE_FORMAT=txt

REM �����Ƿ����� CLEWD ����
set CLEWD_ENABLED=false

REM ���� Node.js Ӧ�ó���
call node --expose-gc index.mjs

REM ��ͣ�ű�ִ��,�ȴ��û���������˳�
pause