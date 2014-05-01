var bootstrap = function (callback) {
    var options = restoreOptions();
    
    var url = options.search_server + '/sidebyside/chrome/parameters/';
    $.ajax({
        "type": "GET",
        "url": url
    }).success(function(result){
        for (var key in result) {
            var key1 = key.toUpperCase();
            if (Params.hasOwnProperty(key1)) {
                var current_value = Params[key1];
                var new_value = result[key];
                if (typeof(current_value) == typeof(new_value)) {
                    console.log('Accepting remote setting', key1, current_value, new_value);
                    Params[key1] = result[key];
                }
            }
        }
    
        // Update these settings same time tomorrow
        setTimeout(bootstrap, 86400000);
    }).error(function(){
        // Try again in an hour
        setTimeout(bootstrap, 3600000);
    }).then(function(){
        $.get(options.search_server + '/static/localnews.json').success(function(result){
            LocalNews = result;
            LocalNews.sort();
            console.log("Fetched " + LocalNews.length + " local news sites.");
        }).then(compileWhitelist);
    });
};

var executeScriptsSynchronously = function (tab_id, files, callback) {
    if (files.length > 0) {
        var file = files[0];
        var rest = files.slice(1);
        chrome.tabs.executeScript(tab_id, {file: file}, function(){
            if (rest.length > 0) {
                executeScriptsSynchronously(tab_id, rest, callback);
            } else if (callback) {
                callback.call(null);
            }
        });
    }
};


var sufficient_coverage = function (row) {
    return ((row['coverage'][0] >= Params['MINIMUM_COVERAGE_CHARS']) 
            && (Math.round(row['coverage'][1]) >= Params['MINIMUM_COVERAGE_PCT']));
};

var select_search_result = function (search_results, predicate) {
    var rows = search_results['documents']['rows'];
    return rows.reduce(function(state, row){
        var attr = predicate(row);
        if (attr > state[0]) {
            return [attr, row];
        } else {
            return state;
        }
    }, [null, null])[1];
};

var with_best_search_result = function (text, results, next) {
    var row_coverage_and_density = function(row){ return row['coverage'][0] + row['density']; };
    var best = select_search_result(results, row_coverage_and_density);
    next(best);
};
    
var explain_no_match = function (tabId) {
    chrome.pageAction.setIcon({tabId: tabId, path: "/img/nonefound.png"});
    chrome.pageAction.setTitle({tabId: tabId, title: "This page is Churnalism-free"});
    chrome.pageAction.setPopup({tabId: tabId, popup: "/html/explainnomatch.html?tabId=" + tabId});
};

var optimistic_search = function (tab) {
    var options = restoreOptions();
    var uuid = UUID.uuid5(UUID.NAMESPACE_URL, tab.get('url'));
    var search_url = options.search_server + '/api/search/' + uuid.toString() + '/';
    $.ajax({type: "GET", url: search_url}).success(function(result){
        tab.set({
            'search_result': result,
            'article_text': result.text,
            'article_title': result.title
        });
        with_best_search_result(result.text, result, function(best_match){
            if (best_match && sufficient_coverage(best_match)) {
                requestRibbonInjection(tab.get('id'), tab.get('url'), result.uuid, best_match.doctype, best_match.docid);
                track_event('search', 'optimistic_hit');
            } else {
                explain_no_match(tab.get('id'));
                track_event('search', 'optimistic_miss');
            }
        });
    }).error(function(xhr, text_status, error){
        chrome.tabs.sendRequest(tab.get('id'), {'method': 'extractArticle'});
        track_event('diagnostic', 'optimistic_error', xhr.status);
    });
};

var checkForValidUrl = function (tab) {
    if (Params['MINIMUM_COVERAGE_PCT'] == Number.MAX_VALUE)
        return;

    var loc = parseUri(tab.get('url'));
    if (loc.path == '/')
        return;

    if (onWhitelist({'host': loc.host, 'pathname': loc.path})) {
        chrome.pageAction.show(tab.get('id'));
        chrome.pageAction.setPopup({'tabId': tab.get('id'), 'popup': ''});

        chrome.tabs.insertCSS(tab.get('id'), {file: "/css/churnalism.css"});
        executeScriptsSynchronously(tab.get('id'), [
            "/js/jquery-1.7.1.min.js",
            "/js/jquery-ui-1.8.20.custom.min.js",
            "/js/logwrapper.js",
            "/js/extractor.js",
            "/js/content_script.js"
        ]);
    }
};

var comparisonUrl = function (uuid, doctype, docid) {
    var options = restoreOptions();
    var url = options.search_server + '/sidebyside/chrome/__UUID__/__DOCTYPE__/__DOCID__/';
    url = url.replace('__UUID__', uuid)
             .replace('__DOCTYPE__', doctype)
             .replace('__DOCID__', docid);
    return url;
};

var requestRibbonInjection = function (tabId, page_url, uuid, doctype, docid) {
    chrome.pageAction.setIcon({tabId: tabId, path: "/img/found.png"});
    chrome.pageAction.setTitle({tabId: tabId, title: "Churnalism Alert!"});
    chrome.pageAction.setPopup({tabId: tabId, popup: ""});
    var options = restoreOptions();

    var url_parts = parseUri(page_url);
    var origin = url_parts.protocol + '://' + url_parts.host;
    var req = {
        'method': 'injectWarningRibbon',
        'src': options.search_server + Params['WARNING_RIBBON_SRC'] + '?domain=' + origin,
        'loading_url': chrome.extension.getURL('/html/loadingwait.html'),
        'match': {
            'url': comparisonUrl(uuid,
                                 doctype,
                                 docid)
        }
    };
    chrome.tabs.sendRequest(tabId, req);
};

var requestIFrameInjection = function (chromeTab) {
    var tab = Tabs.get(chromeTab.id);
    if (tab == null) {
        throw 'Unknown tab (' + chromeTab.id + ') -- the world is falling apart!';
    }

    var options = restoreOptions();
    var url = options.search_server + '/sidebyside/chrome/__UUID__/__DOCTYPE__/__DOCID__/';
    var search_result = tab.get('search_result');
    if ((search_result == null) || (search_result['documents']['rows'].length == 0))
        return;

    with_best_search_result(tab.get('article_text'), search_result, function(best_match){
        var req = {
            'method': 'injectIFrame',
            'loading_url': chrome.extension.getURL('/html/loadingwait.html'),
            'url': comparisonUrl(search_result.uuid,
                                 best_match.doctype,
                                 best_match.docid)
        };
        chrome.tabs.sendRequest(tab.get('id'), req);
    });
};

var handleMessage = function (request, sender, response) {
    console.log(request.method, request, sender);
    if (request.method == "ready") {
        optimistic_search(Tabs.get(sender.tab.id));

    } else if (request.method == "articleExtracted") {
        if (request.text.length == 0) {
            chrome.pageAction.hide(sender.tab.id);
            return;
        }

        var options = restoreOptions();

        var tab = Tabs.get(sender.tab.id);

        var prior_result = tab.get('search_result');
        if (prior_result == null) {
            var query_params = {
                'title': request.title,
                'text': request.text
            };
            if (options.submit_urls) {
                query_params['url'] = request.url;
            }
            tab.set({
                'article_text': request.text,
                'article_title': request.title
            });

            var url = options.search_server + '/api/search/';
            $.ajax({
                "type": "POST",
                "url": url,
                "data": query_params
            }).success(function(result){
                with_best_search_result(request.text, result, function(best_match){
                    if (best_match && sufficient_coverage(best_match)) {
                        requestRibbonInjection(sender.tab.id, tab.get('url'), result.uuid, best_match.doctype, best_match.docid);
                        track_event('search', 'normal_hit');
                    } else {
                        explain_no_match(sender.tab.id);
                        track_event('search', 'normal_miss');
                    }
                });
                tab.set({'search_result': result});
                response(result);
            }).error(function(xhr, text_status, error_thrown){
                chrome.pageAction.hide(tab.get('id'));
                track_event('diagnostic', 'normal_error', xhr.status);
            });

        } else {
            // Older Chrome versions don't provide the webNavigation API so we have to rely on the
            // tabs.onUpdated event to signal when to extract the article text. Unfortunately this leads
            // to multiple article extractions and we don't want to make a network request for each.
            with_best_search_result(tab.get('article_text'), prior_result, function(best_match){
                if (best_match && sufficient_coverage(best_match)) {
                    requestRibbonInjection(sender.tab.id, tab.get('url'), result.uuid, best_match.doctype, best_match.docid);
                } else {
                    explain_no_match(sender.tab.id);
                }
            });
        }

    } else if (request.method == 'getAllBrowserTabs') {
        chrome.windows.getAll({populate: true}, function(windows){
            var tabs = [];
            jQuery(windows).each(function(winIdx, win){
                jQuery(win.tabs).each(function(tabIdx, tab) {
                    tabs.push(tab);
                });
            });
            response(tabs);
        });

    } else if (request.method == 'reportTextProblem') {
        var options = restoreOptions();
        var tab = Tabs.get(request.tabId);
        var search_result = tab.get('search_result');
        if (search_result != null) {
            var url = options.search_server + '/sidebyside/__UUID__/textproblem/'.replace('__UUID__', search_result.uuid);
            chrome.tabs.create({'url': url});
        }

    } else if (request.method == 'showOptionsPage') {
        chrome.tabs.create({
            url: chrome.extension.getURL("html/options.html")
        });

    } else if (request.method == 'getTab') {
        response(Tabs.get(request.tabId));

    } else if (request.method == 'getLocalNews') {
        response(LocalNews);

    } else if (request.method == 'whoami?') {
        response(sender.tab);

    } else if (request.method == "getParameters") {
        response(Params);

    } else if (request.method == "getOptions") {
        response(restoreOptions());

    } else if (request.method == "saveOptions") {
        response(saveOptions(request.options));

    } else if (request.method == "resetOptions") {
        response(resetOptions());

    } else if (request.method == "addToWhitelist") {
        var options = restoreOptions();
        if (options.sites.indexOf(request.site) == -1) {
            options.sites.push(request.site);
            saveOptions(options);
        }
        response(options);

    } else if (request.method == "removeFromWhitelist") {
        var options = restoreOptions();
        var offset = options.sites.indexOf(request.site);
        if (offset >= 0) {
            options.sites.splice(offset, 1);
            saveOptions(options);
        }
        response(options);

    } else if (request.method == "log") {
        console.log(request.args);
    }
};

bootstrap();

chrome.tabs.onRemoved.addListener(function(tabId, removeInfo){
    Tabs.remove(tabId);
});
if (chrome.webNavigation == null) {
    console.log('chrome.webNavigation is not supported by this browser, falling back to chrome.tabs');
    chrome.tabs.onUpdated.addListener(function(tabId, changeInfo, chromeTab){
        if (changeInfo.status == 'complete') {
            var tab = Tabs.get_or_create(tabId);
            tab.set({'url': chromeTab.url});
            checkForValidUrl(tab);
        }
    });
} else {
    chrome.webNavigation.onCommitted.addListener(function(details){
        if (details.frameId != 0)
            return;

        var tab = Tabs.get_or_create(details.tabId);
        if (details.transitionType == 'reload') {
            tab.set({'url': null});
        }
    });
    chrome.webNavigation.onDOMContentLoaded.addListener(function(details){
        if (details.frameId != 0)
            return;

        var tab = Tabs.get_or_create(details.tabId);
        if (tab == null) {
            throw 'No such tab found: ' + details.tabId;
        }
        tab.set({'url': details.url});
        checkForValidUrl(tab);
    });
}
chrome.pageAction.onClicked.addListener(requestIFrameInjection);
chrome.extension.onRequest.addListener(handleMessage);
