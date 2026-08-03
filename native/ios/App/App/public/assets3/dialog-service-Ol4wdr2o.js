var e=null,t=null;function n(n){e=n.confirm,t=n.notify}function r(e,t){return[e,typeof t==`string`?t:``].filter(Boolean).join(`

`)}function i(t){return e?e(t):Promise.resolve(window.confirm(r(t.title,t.body)))}function a(e){return t?t(e):(window.alert(r(e.title,e.body)),Promise.resolve())}export{i as n,a as r,n as t};