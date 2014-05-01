(function($){

    $(document).ready(function(){

        var log = new LogWrapper(LogWrapper.DEBUG);
        console.log('hi');
        log.error('nytgoogle started');

        var host_pattern = /((\w+\.)+)?nytimes.com/;

        var anchors = $("a").toArray();
        log.debug('Anchors found:', anchors.length);
        anchors.forEach(function(anchor){
            var $anchor = $(anchor);
            var href = $anchor.attr('href');
            if (href != null) {
                var uri = parseUri(href);

                if ((uri.protocol === 'http') && (host_pattern.test(uri.host) === true)) {
                    log.debug("Would redirect", href);

                    var google_href = ['https://www.google.com/search?q=http://',
                                       uri.host,
                                       (uri.port === 80) ? '' : uri.port.toString(),
                                       uri.path].join('');
                    $anchor.attr('href', google_href);
                }
            }
        });
    });

})(jQuery);
