(function () {
    const nativeFetch = window.fetch.bind(window);
    window.fetch = async function (input, init) {
        const url = typeof input === 'string' ? input : String((input && input.url) || '');
        if ((url.startsWith('/api/') || url.indexOf('/api/') !== -1) && window.__tcgSupabase) {
            try {
                const { data: { session } } = await window.__tcgSupabase.auth.getSession();
                init = init ? Object.assign({}, init) : {};
                const headers = new Headers(init.headers || {});
                if (session && session.access_token && !headers.has('Authorization')) {
                    headers.set('Authorization', 'Bearer ' + session.access_token);
                }
                if (init.body && !headers.has('Content-Type')) {
                    headers.set('Content-Type', 'application/json');
                }
                init.headers = headers;
            } catch (e) {}
        }
        return nativeFetch(input, init);
    };
})();
