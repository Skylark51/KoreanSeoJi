#include <windows.h>
#include <wrl.h>
#include <shlobj.h>
#include <shellapi.h>
#include <shlwapi.h>
#include <commdlg.h>
#include <filesystem>
#include <fstream>
#include <string>
#include <vector>
#include <stdexcept>
#include <algorithm>
#include <WebView2.h>
#include <json.hpp>
#include <sqlite3.h>
#include "assets.h"

using Microsoft::WRL::Callback;
using Microsoft::WRL::ComPtr;
using json = nlohmann::json;
namespace fs = std::filesystem;
static HWND windowHandle;
static ComPtr<ICoreWebView2Controller> controller;
static ComPtr<ICoreWebView2> webview;
static fs::path dataDir, uiDir;
static sqlite3* database = nullptr;
static HANDLE libraryLock = INVALID_HANDLE_VALUE;
static bool closeApproved = false;
static bool selfTest = false;
static fs::path pendingPdf, pendingExplanation;

static std::string utf8(const std::wstring& s) {
    if(s.empty()) return {};
    int n = WideCharToMultiByte(CP_UTF8,0,s.data(),(int)s.size(),nullptr,0,nullptr,nullptr);
    std::string out(n,0); WideCharToMultiByte(CP_UTF8,0,s.data(),(int)s.size(),out.data(),n,nullptr,nullptr); return out;
}
static std::wstring wide(const std::string& s) {
    if(s.empty()) return {};
    int n = MultiByteToWideChar(CP_UTF8,MB_ERR_INVALID_CHARS,s.data(),(int)s.size(),nullptr,0);
    if(!n) throw std::runtime_error("Invalid UTF-8");
    std::wstring out(n,0); MultiByteToWideChar(CP_UTF8,0,s.data(),(int)s.size(),out.data(),n); return out;
}
static void check(HRESULT hr, const char* message) { if(FAILED(hr)) throw std::runtime_error(message); }
static void sql(const char* s) {
    char* error = nullptr;
    if(sqlite3_exec(database,s,nullptr,nullptr,&error)!=SQLITE_OK) {
        std::string message = error ? error : sqlite3_errmsg(database); sqlite3_free(error); throw std::runtime_error(message);
    }
}
struct Statement {
    sqlite3_stmt* p = nullptr;
    Statement(const char* s) { if(sqlite3_prepare_v2(database,s,-1,&p,nullptr)!=SQLITE_OK) throw std::runtime_error(sqlite3_errmsg(database)); }
    ~Statement() { sqlite3_finalize(p); }
    void text(int i, const std::string& s) { if(sqlite3_bind_text(p,i,s.c_str(),(int)s.size(),SQLITE_TRANSIENT)!=SQLITE_OK) throw std::runtime_error("Bind failed"); }
    int step() { int r=sqlite3_step(p); if(r!=SQLITE_ROW && r!=SQLITE_DONE) throw std::runtime_error(sqlite3_errmsg(database)); return r; }
    std::string value(int i) { const auto* s=sqlite3_column_text(p,i); return s?reinterpret_cast<const char*>(s):""; }
};
static std::string guid() {
    GUID g; check(CoCreateGuid(&g),"Cannot create identifier"); wchar_t buf[40]; StringFromGUID2(g,buf,40);
    std::wstring s(buf); s.erase(std::remove(s.begin(),s.end(),L'{'),s.end()); s.erase(std::remove(s.begin(),s.end(),L'}'),s.end()); return utf8(s);
}
static std::wstring stamp() {
    SYSTEMTIME t; GetLocalTime(&t); wchar_t s[40]; swprintf_s(s,L"%04d%02d%02d-%02d%02d%02d",t.wYear,t.wMonth,t.wDay,t.wHour,t.wMinute,t.wSecond); return s;
}
static void backupDatabase(const fs::path& destination) {
    sqlite3* target=nullptr;
    if(sqlite3_open16(destination.c_str(),&target)!=SQLITE_OK) { if(target) sqlite3_close(target); throw std::runtime_error("백업 파일을 만들 수 없습니다."); }
    auto* b=sqlite3_backup_init(target,"main",database,"main");
    if(!b) { sqlite3_close(target); throw std::runtime_error("백업을 시작할 수 없습니다."); }
    int r=sqlite3_backup_step(b,-1); int finish=sqlite3_backup_finish(b); sqlite3_close(target);
    if(r!=SQLITE_DONE || finish!=SQLITE_OK) throw std::runtime_error("백업 저장에 실패했습니다.");
}
static void validateState(const json& state) {
    if(!state.is_object() || state.value("schemaVersion",0)!=1 || !state.contains("projects") || !state["projects"].is_array() || !state.contains("links") || !state["links"].is_array()) throw std::runtime_error("저장 데이터 형식이 올바르지 않습니다.");
    std::vector<std::string> ids;
    for(const auto& p:state["projects"]) {
        if(!p.contains("id") || !p.contains("questions") || !p["questions"].is_array()) throw std::runtime_error("프로젝트 형식 오류");
        for(const auto& q:p["questions"]) {
            std::string id=q.at("id"); if(std::find(ids.begin(),ids.end(),id)!=ids.end()) throw std::runtime_error("중복 문제 ID"); ids.push_back(id);
        }
    }
    std::vector<std::string> pairs;
    for(const auto& l:state["links"]) {
        std::string a=l.at("a"), b=l.at("b");
        if(a==b || std::find(ids.begin(),ids.end(),a)==ids.end() || std::find(ids.begin(),ids.end(),b)==ids.end()) throw std::runtime_error("참조 대상이 올바르지 않습니다.");
        std::string pair=std::min(a,b)+":"+std::max(a,b);
        if(std::find(pairs.begin(),pairs.end(),pair)!=pairs.end()) throw std::runtime_error("중복 참조"); pairs.push_back(pair);
    }
}
static json loadState() {
    Statement s("SELECT payload,revision FROM state WHERE id=1");
    if(s.step()!=SQLITE_ROW) throw std::runtime_error("저장 데이터가 없습니다.");
    auto state=json::parse(s.value(0)); validateState(state);
    return {{"state",state},{"revision",sqlite3_column_int64(s.p,1)},{"dataPath",utf8(dataDir.wstring())},{"version","0.3.0"},{"pendingExplanation",!pendingExplanation.empty()},{"pendingPdf",pendingPdf.empty()?"":utf8(pendingPdf.stem().wstring())}};
}
static json saveState(const json& args) {
    const auto& state=args.at("state"); validateState(state); std::string payload=state.dump();
    if(payload.size()>64*1024*1024) throw std::runtime_error("저장 데이터가 64 MB를 초과했습니다.");
    sql("BEGIN IMMEDIATE");
    try {
        long long revision;
        { Statement s("SELECT revision FROM state WHERE id=1"); s.step(); revision=sqlite3_column_int64(s.p,0); }
        if(revision!=args.at("revision").get<long long>()) throw std::runtime_error("저장 버전이 달라 덮어쓰지 않았습니다. 프로그램을 다시 열어 주세요.");
        { Statement s("INSERT INTO revisions(payload,created) SELECT payload,datetime('now') FROM state WHERE id=1"); s.step(); }
        { Statement s("UPDATE state SET payload=?1,revision=revision+1 WHERE id=1"); s.text(1,payload); s.step(); }
        sql("DELETE FROM revisions WHERE id NOT IN (SELECT id FROM revisions ORDER BY id DESC LIMIT 100)");
        sql("COMMIT");
        return {{"revision",revision+1}};
    } catch(...) { sqlite3_exec(database,"ROLLBACK",nullptr,nullptr,nullptr); throw; }
}
static fs::path pickPdf() {
    ComPtr<IFileOpenDialog> dialog; check(CoCreateInstance(CLSID_FileOpenDialog,nullptr,CLSCTX_INPROC_SERVER,IID_PPV_ARGS(&dialog)),"파일 선택 창 오류");
    COMDLG_FILTERSPEC types[]={{L"PDF 문서",L"*.pdf"}}; dialog->SetFileTypes(1,types); dialog->SetTitle(L"기출 문제 PDF 가져오기");
    if(dialog->Show(windowHandle)==HRESULT_FROM_WIN32(ERROR_CANCELLED)) return {};
    ComPtr<IShellItem> item; check(dialog->GetResult(&item),"파일 선택 오류");
    PWSTR raw=nullptr; check(item->GetDisplayName(SIGDN_FILESYSPATH,&raw),"파일 경로 오류"); fs::path result(raw); CoTaskMemFree(raw); return result;
}
static json importPdf(bool explanation=false) {
    auto& pending=explanation?pendingExplanation:pendingPdf;
    auto path=pending.empty()?pickPdf():pending; pending.clear(); if(path.empty()) return nullptr;
    if(fs::file_size(path)>512ULL*1024*1024) throw std::runtime_error("512 MB 이하의 PDF를 선택해 주세요.");
    std::ifstream input(path,std::ios::binary); char header[5]{}; input.read(header,5);
    if(std::string(header,5)!="%PDF-") throw std::runtime_error("PDF 형식의 파일이 아닙니다.");
    std::string id=guid(); fs::path dest=dataDir/L"pdfs"/(wide(id)+L".pdf");
    fs::copy_file(path,dest.wstring()+L".part"); fs::rename(dest.wstring()+L".part",dest);
    return {{"id",id},{"name",utf8(path.filename().wstring())},{"url","https://pdf.seoji.local/"+id+".pdf"}};
}
static json dispatch(const std::string& action, const json& args) {
    if(action=="load") return loadState();
    if(action=="save") return saveState(args);
    if(action=="importPdf") return importPdf();
    if(action=="importExplanation") return importPdf(true);
    if(action=="openData") { ShellExecuteW(windowHandle,L"open",dataDir.c_str(),nullptr,nullptr,SW_SHOWNORMAL); return true; }
    if(action=="backup") {
        ComPtr<IFileOpenDialog> dialog; check(CoCreateInstance(CLSID_FileOpenDialog,nullptr,CLSCTX_INPROC_SERVER,IID_PPV_ARGS(&dialog)),"백업 위치 선택 오류");
        dialog->SetOptions(FOS_PICKFOLDERS|FOS_FORCEFILESYSTEM); dialog->SetTitle(L"백업을 저장할 폴더 선택");
        if(FAILED(dialog->Show(windowHandle))) return nullptr;
        ComPtr<IShellItem> item; check(dialog->GetResult(&item),"백업 위치 오류"); PWSTR raw=nullptr; item->GetDisplayName(SIGDN_FILESYSPATH,&raw); fs::path base(raw); CoTaskMemFree(raw);
        // A backup inside Data would recursively copy itself. Refuse that destination.
        auto source=fs::weakly_canonical(dataDir).wstring(); auto target=fs::weakly_canonical(base).wstring();
        std::transform(source.begin(),source.end(),source.begin(),::towlower); std::transform(target.begin(),target.end(),target.begin(),::towlower);
        if(target==source || target.starts_with(source+L"\\")) throw std::runtime_error("Data 폴더 밖의 위치를 선택해 주세요.");
        fs::path dest=base/(L"KoreanSeoJi-backup-"+stamp()+L"-"+wide(guid().substr(0,8))); fs::create_directories(dest/L"pdfs");
        backupDatabase(dest/L"library.sqlite3"); fs::copy(dataDir/L"pdfs",dest/L"pdfs",fs::copy_options::recursive|fs::copy_options::overwrite_existing);
        std::ofstream readme(dest/L"복원방법.txt"); readme << "Close KoreanSeoJi. Keep a copy of the current Data folder. Copy library.sqlite3 and pdfs from this backup into Data next to KoreanSeoJi.exe.\n";
        return {{"path",utf8(dest.wstring())}};
    }
    if(action=="history") {
        json result=json::array(); Statement s("SELECT id,created FROM revisions ORDER BY id DESC LIMIT 30");
        while(s.step()==SQLITE_ROW) result.push_back({{"id",sqlite3_column_int64(s.p,0)},{"created",s.value(1)}}); return result;
    }
    if(action=="restoreRevision") {
        json state;
        { Statement s("SELECT payload FROM revisions WHERE id=?1"); sqlite3_bind_int64(s.p,1,args.at("id").get<long long>()); if(s.step()!=SQLITE_ROW) throw std::runtime_error("저장 이력을 찾을 수 없습니다."); state=json::parse(s.value(0)); }
        return {{"state",state}};
    }
    if(action=="close") { closeApproved=true; PostMessageW(windowHandle,WM_CLOSE,0,0); return true; }
    throw std::runtime_error("알 수 없는 요청입니다.");
}
static void reply(const json& message) { if(webview) webview->PostWebMessageAsJson(wide(message.dump()).c_str()); }
static LRESULT CALLBACK windowProc(HWND h,UINT m,WPARAM w,LPARAM l) {
    if(m==WM_SIZE && controller) { RECT r; GetClientRect(h,&r); controller->put_Bounds(r); return 0; }
    if(m==WM_GETMINMAXINFO) { auto* p=reinterpret_cast<MINMAXINFO*>(l); p->ptMinTrackSize={1000,680}; return 0; }
    if(m==WM_CLOSE) {
        if(!closeApproved && webview) { webview->ExecuteScript(L"window.requestClose && window.requestClose()",nullptr); return 0; }
        DestroyWindow(h); return 0;
    }
    if(m==WM_DESTROY) { PostQuitMessage(0); return 0; }
    return DefWindowProcW(h,m,w,l);
}
static void initDatabase() {
    fs::create_directories(dataDir/L"pdfs"); fs::create_directories(dataDir/L"backups");
    libraryLock=CreateFileW((dataDir/L"library.lock").c_str(),GENERIC_READ|GENERIC_WRITE,0,nullptr,OPEN_ALWAYS,FILE_ATTRIBUTE_NORMAL,nullptr);
    if(libraryLock==INVALID_HANDLE_VALUE) throw std::runtime_error("이 데이터 폴더를 사용하는 프로그램이 이미 열려 있거나 폴더에 쓰기 권한이 없습니다.");
    if(sqlite3_open16((dataDir/L"library.sqlite3").c_str(),&database)!=SQLITE_OK) throw std::runtime_error("저장소를 열 수 없습니다. Data 폴더의 쓰기 권한을 확인해 주세요.");
    sqlite3_busy_timeout(database,5000);
    { Statement s("PRAGMA quick_check"); if(s.step()!=SQLITE_ROW || s.value(0)!="ok") throw std::runtime_error("저장소 손상이 감지되었습니다. Data 폴더를 보존하고 backups 폴더의 백업으로 복원해 주세요."); }
    sql("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;");
    sql("CREATE TABLE IF NOT EXISTS state(id INTEGER PRIMARY KEY CHECK(id=1),payload TEXT NOT NULL,revision INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS revisions(id INTEGER PRIMARY KEY AUTOINCREMENT,payload TEXT NOT NULL,created TEXT NOT NULL);");
    { Statement s("INSERT OR IGNORE INTO state VALUES(1,?1,0)"); s.text(1,json({{"schemaVersion",1},{"projects",json::array()},{"links",json::array()},{"settings",json::object()}}).dump()); s.step(); }
    loadState(); // Never silently replace a corrupt or incompatible library.
    auto daily=stamp().substr(0,8); auto backup=dataDir/L"backups"/(L"library-"+daily+L".sqlite3");
    if(!fs::exists(backup)) backupDatabase(backup);
}
static void extractAssets() {
    uiDir=dataDir/L".runtime"/assetVersion/L"ui";
    for(const auto& a:assets) {
        fs::path file=uiDir/a.path;
        HRSRC r=FindResourceW(nullptr,MAKEINTRESOURCEW(a.id),RT_RCDATA); if(!r) throw std::runtime_error("화면 리소스가 없습니다.");
        auto size=SizeofResource(nullptr,r);
        if(fs::exists(file) && fs::file_size(file)==size) continue;
        auto* bytes=LockResource(LoadResource(nullptr,r)); fs::create_directories(file.parent_path());
        auto partial=file.wstring()+L".part"; std::ofstream stream(partial,std::ios::binary|std::ios::trunc); stream.write(static_cast<const char*>(bytes),size); stream.flush();
        if(!stream) throw std::runtime_error("화면 리소스 저장 실패. 남은 디스크 공간을 확인해 주세요."); stream.close();
        MoveFileExW(partial.c_str(),file.c_str(),MOVEFILE_REPLACE_EXISTING|MOVEFILE_WRITE_THROUGH);
    }
}
static void setupWebview() {
    auto profile=dataDir/L".runtime"/L"browser";
    HRESULT start=CreateCoreWebView2EnvironmentWithOptions(nullptr,profile.c_str(),nullptr,Callback<ICoreWebView2CreateCoreWebView2EnvironmentCompletedHandler>([](HRESULT result,ICoreWebView2Environment* env)->HRESULT {
        if(FAILED(result)||!env) { MessageBoxW(windowHandle,L"Microsoft Edge WebView2 Runtime이 필요합니다. Microsoft 공식 WebView2 Runtime을 설치한 후 다시 실행해 주세요.",L"국어 기출 학습",MB_ICONERROR); closeApproved=true; PostMessageW(windowHandle,WM_CLOSE,0,0); return S_OK; }
        ComPtr<ICoreWebView2Environment> environment=env;
        return env->CreateCoreWebView2Controller(windowHandle,Callback<ICoreWebView2CreateCoreWebView2ControllerCompletedHandler>([environment](HRESULT hr,ICoreWebView2Controller* c)->HRESULT {
            if(FAILED(hr)||!c) { MessageBoxW(windowHandle,L"화면을 시작할 수 없습니다.",L"국어 기출 학습",MB_ICONERROR); closeApproved=true; PostMessageW(windowHandle,WM_CLOSE,0,0); return S_OK; }
            controller=c; controller->get_CoreWebView2(&webview); RECT bounds; GetClientRect(windowHandle,&bounds); controller->put_Bounds(bounds);
            ComPtr<ICoreWebView2Settings> settings; webview->get_Settings(&settings); settings->put_AreDevToolsEnabled(FALSE); settings->put_AreDefaultContextMenusEnabled(FALSE); settings->put_IsStatusBarEnabled(FALSE);
            ComPtr<ICoreWebView2_3> web3; webview.As(&web3);
            if(!web3) { MessageBoxW(windowHandle,L"WebView2 Runtime을 업데이트해 주세요.",L"국어 기출 학습",MB_ICONERROR); closeApproved=true; PostMessageW(windowHandle,WM_CLOSE,0,0); return S_OK; }
            web3->SetVirtualHostNameToFolderMapping(L"seoji.local",uiDir.c_str(),COREWEBVIEW2_HOST_RESOURCE_ACCESS_KIND_DENY_CORS);
            web3->SetVirtualHostNameToFolderMapping(L"pdf.seoji.local",(dataDir/L"pdfs").c_str(),COREWEBVIEW2_HOST_RESOURCE_ACCESS_KIND_ALLOW);
            EventRegistrationToken token;
            webview->add_NavigationStarting(Callback<ICoreWebView2NavigationStartingEventHandler>([](ICoreWebView2*,ICoreWebView2NavigationStartingEventArgs* e)->HRESULT {
                LPWSTR raw=nullptr; e->get_Uri(&raw); std::wstring uri=raw?raw:L""; CoTaskMemFree(raw); if(!uri.starts_with(L"https://seoji.local/")) e->put_Cancel(TRUE); return S_OK;
            }).Get(),&token);
            webview->add_NewWindowRequested(Callback<ICoreWebView2NewWindowRequestedEventHandler>([](ICoreWebView2*,ICoreWebView2NewWindowRequestedEventArgs* e)->HRESULT { e->put_Handled(TRUE); return S_OK; }).Get(),&token);
            webview->AddWebResourceRequestedFilter(L"*",COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL);
            webview->add_WebResourceRequested(Callback<ICoreWebView2WebResourceRequestedEventHandler>([environment](ICoreWebView2*,ICoreWebView2WebResourceRequestedEventArgs* e)->HRESULT {
                ComPtr<ICoreWebView2WebResourceRequest> request; e->get_Request(&request); LPWSTR raw=nullptr; request->get_Uri(&raw); std::wstring uri(raw?raw:L""); CoTaskMemFree(raw);
                if(!uri.starts_with(L"https://seoji.local/") && !uri.starts_with(L"https://pdf.seoji.local/") && !uri.starts_with(L"blob:https://seoji.local/") && !uri.starts_with(L"data:")) {
                    ComPtr<ICoreWebView2WebResourceResponse> response; environment->CreateWebResourceResponse(nullptr,403,L"Offline application",L"",&response); e->put_Response(response.Get());
                }
                return S_OK;
            }).Get(),&token);
            webview->add_WebMessageReceived(Callback<ICoreWebView2WebMessageReceivedEventHandler>([](ICoreWebView2*,ICoreWebView2WebMessageReceivedEventArgs* e)->HRESULT {
                LPWSTR raw=nullptr; e->get_WebMessageAsJson(&raw); std::wstring message=raw?raw:L""; CoTaskMemFree(raw); json request;
                try { request=json::parse(utf8(message)); auto id=request.at("id"); auto result=dispatch(request.at("action"),request.value("args",json::object())); reply({{"id",id},{"ok",true},{"result",result}}); }
                catch(const std::exception& error) { reply({{"id",request.value("id",0)},{"ok",false},{"error",error.what()}}); }
                return S_OK;
            }).Get(),&token);
            webview->Navigate(L"https://seoji.local/index.html"); return S_OK;
        }).Get());
    }).Get());
    if(FAILED(start)) throw std::runtime_error("WebView2 Runtime을 시작할 수 없습니다. Microsoft Edge WebView2 Runtime을 설치해 주세요.");
}
static void runSelfTest() {
    initDatabase(); auto before=loadState(); auto state=before["state"];
    state["projects"].push_back({{"id","p1"},{"questions",json::array({json{{"id","q1"},{"notes",{{"thought","재실행 후에도 남는 한글 메모"}}}},json{{"id","q2"}}})}});
    state["links"].push_back({{"a","q1"},{"b","q2"}});
    auto saved=saveState({{"state",state},{"revision",before["revision"]}});
    if(loadState()["state"]!=state) throw std::runtime_error("Persistence failed");
    bool rejected=false; try { saveState({{"state",state},{"revision",before["revision"]}}); } catch(...) { rejected=true; }
    if(!rejected) throw std::runtime_error("Stale revision accepted");
    auto invalid=state; invalid["links"].push_back({{"a","q1"},{"b","missing"}}); rejected=false;
    try { saveState({{"state",invalid},{"revision",saved["revision"]}}); } catch(...) { rejected=true; }
    if(!rejected) throw std::runtime_error("Invalid reference accepted");
    backupDatabase(dataDir/L"selftest-backup.sqlite3");
    sqlite3_close(database); database=nullptr; CloseHandle(libraryLock); libraryLock=INVALID_HANDLE_VALUE;
    initDatabase(); if(loadState()["state"]!=state) throw std::runtime_error("Reopen failed");
    std::ofstream(dataDir/L"selftest-result.txt") << "PASS: Korean persistence, reopen, revision conflict, reference integrity, SQLite backup\n";
}
int WINAPI wWinMain(HINSTANCE instance,HINSTANCE,PWSTR,int show) {
    SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
    HRESULT co=CoInitializeEx(nullptr,COINIT_APARTMENTTHREADED);
    int result=0;
    try {
        wchar_t exe[32768]; GetModuleFileNameW(nullptr,exe,32768); dataDir=fs::path(exe).parent_path()/L"Data";
        int argc=0; LPWSTR* argv=CommandLineToArgvW(GetCommandLineW(),&argc);
        for(int i=1;i<argc;i++) {
            if(std::wstring(argv[i])==L"--self-test") selfTest=true;
            if(std::wstring(argv[i])==L"--data-dir" && i+1<argc) dataDir=fs::absolute(argv[++i]);
            if(std::wstring(argv[i])==L"--explanation" && i+1<argc) pendingExplanation=fs::absolute(argv[++i]);
            else if(std::wstring(argv[i])==L"--pdf" && i+1<argc) pendingPdf=fs::absolute(argv[++i]);
            else if(fs::path(argv[i]).extension()==L".pdf") pendingPdf=fs::absolute(argv[i]);
        } LocalFree(argv);
        if(selfTest) runSelfTest();
        else {
            initDatabase(); extractAssets();
            WNDCLASSW wc{}; wc.lpfnWndProc=windowProc; wc.hInstance=instance; wc.lpszClassName=L"KoreanSeoJiWindow"; wc.hCursor=LoadCursor(nullptr,IDC_ARROW); wc.hbrBackground=CreateSolidBrush(RGB(246,247,249)); wc.hIcon=LoadIcon(instance,MAKEINTRESOURCE(2)); RegisterClassW(&wc);
            windowHandle=CreateWindowExW(0,wc.lpszClassName,L"국어 기출 학습 · KoreanSeoJi",WS_OVERLAPPEDWINDOW,CW_USEDEFAULT,CW_USEDEFAULT,1440,960,nullptr,nullptr,instance,nullptr);
            if(!windowHandle) throw std::runtime_error("창을 만들 수 없습니다."); ShowWindow(windowHandle,show); setupWebview();
            MSG message; while(GetMessageW(&message,nullptr,0,0)>0) { TranslateMessage(&message); DispatchMessageW(&message); }
        }
    } catch(const std::exception& error) {
        result=1;
        if(selfTest) { fs::create_directories(dataDir); std::ofstream(dataDir/L"selftest-result.txt") << "FAIL: " << error.what(); }
        else MessageBoxW(windowHandle,wide(std::string(error.what())+"\n\nData 폴더는 삭제하지 말고 보존해 주세요.").c_str(),L"국어 기출 학습",MB_ICONERROR);
    }
    controller.Reset(); webview.Reset();
    if(database) { sqlite3_wal_checkpoint_v2(database,nullptr,SQLITE_CHECKPOINT_TRUNCATE,nullptr,nullptr); sqlite3_close(database); }
    if(libraryLock!=INVALID_HANDLE_VALUE) CloseHandle(libraryLock);
    if(SUCCEEDED(co)) CoUninitialize(); return result;
}
