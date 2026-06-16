/* ================================================================
   BUK NAVIGATE — LIBRARY MODULE  (library.js)
   Standalone module. No build tools. No dependencies beyond Fuse.js
   (already loaded by the main app boot sequence).

   Public API (called from index.html):
     BUKLibrary.init()           — fetch catalogue, boot module
     BUKLibrary.open()           — open the library overlay
     BUKLibrary.close()          — close the library overlay

   Internal flow:
     fetch library.json → build Fuse index → render course list
     → user picks course → render resource list
     → user taps resource → open PDF viewer OR external link
================================================================ */

var BUKLibrary = (function () {

  /* ----------------------------------------------------------
     CONFIG
  ---------------------------------------------------------- */
  // Base URL for library.json. Relative to app root — works on
  // GitHub Pages and localhost without change.
  var CATALOGUE_URL = './library.json';

  // How long (ms) before fetch is considered failed
  var FETCH_TIMEOUT = 8000;

  // Resource type metadata
  var TYPE_META = {
    past_questions: { label: 'Past Questions',  icon: '📝', color: '#0AC4E0' },
    lecture_notes:  { label: 'Lecture Notes',   icon: '📖', color: '#4988C4' },
    lab_manual:     { label: 'Lab Manual',       icon: '🔬', color: '#43D9AD' },
    handout:        { label: 'Handout',          icon: '📄', color: '#BDE8F5' },
    textbook:       { label: 'Textbook',         icon: '📚', color: '#F6E7BC' },
    handbook:       { label: 'University Handbook', icon: '🏛️', color: '#7BB3D8' }
  };

  /* ----------------------------------------------------------
     STATE
  ---------------------------------------------------------- */
  var _catalogue   = null;   // parsed library.json
  var _fuseIndex   = null;   // Fuse.js search index across all resources
  var _activeCourse = null;  // currently open course id
  var _searchQuery  = '';
  var _isOpen       = false;
  var _loaded       = false;
  var _loading      = false;
  var _loadError    = false;

  /* ----------------------------------------------------------
     INIT — fetch catalogue, build search index
  ---------------------------------------------------------- */
  function init() {
    if (_loaded || _loading) return;
    _loading = true;
    _fetchCatalogue();
  }

  function _fetchCatalogue() {
    // Timeout wrapper — fetch can hang silently on bad connections
    var didTimeout = false;
    var timer = setTimeout(function () {
      didTimeout = true;
      _loading = false;
      _loadError = true;
      _renderError('Connection timed out. Pull down to retry.');
    }, FETCH_TIMEOUT);

    fetch(CATALOGUE_URL + '?v=' + Date.now()) // cache-bust on every open
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      })
      .then(function (data) {
        if (didTimeout) return;
        clearTimeout(timer);
        _catalogue = data;
        _buildFuseIndex();
        _loaded = true;
        _loading = false;
        _loadError = false;
        // If overlay is already open (user opened fast), render now
        if (_isOpen) _renderHome();
      })
      .catch(function (err) {
        if (didTimeout) return;
        clearTimeout(timer);
        _loading = false;
        _loadError = true;
        console.warn('[BUKLibrary] Catalogue fetch failed:', err);
        if (_isOpen) _renderError('Could not load library. Check connection.');
      });
  }

  function _buildFuseIndex() {
    // Flatten all resources into one searchable array
    var flat = [];
    (_catalogue.courses || []).forEach(function (course) {
      (course.resources || []).forEach(function (res) {
        flat.push({
          courseId:   course.id,
          courseCode: course.code,
          courseName: course.name,
          id:         res.id,
          title:      res.title,
          type:       res.type,
          session:    res.session || '',
          tags:       (res.tags || []).join(' '),
          url:        res.url
        });
      });
    });

    if (typeof Fuse !== 'undefined') {
      _fuseIndex = new Fuse(flat, {
        threshold: 0.35,
        keys: [
          { name: 'title',      weight: 0.40 },
          { name: 'courseCode', weight: 0.25 },
          { name: 'courseName', weight: 0.20 },
          { name: 'tags',       weight: 0.10 },
          { name: 'session',    weight: 0.05 }
        ]
      });
    }
    // Store flat list for fallback filter
    _fuseIndex._flat = flat;
  }

  /* ----------------------------------------------------------
     OPEN / CLOSE
  ---------------------------------------------------------- */
  function open() {
    _isOpen = true;
    var overlay = document.getElementById('library-overlay');
    if (overlay) overlay.classList.add('open');

    if (_loadError) {
      // Retry fetch on re-open after error
      _loadError = false;
      _loading = false;
      _loaded = false;
      _renderLoading();
      _fetchCatalogue();
      return;
    }

    if (!_loaded) {
      _renderLoading();
      // init() may already be in flight from app boot
      if (!_loading) {
        _loading = true;
        _fetchCatalogue();
      }
      return;
    }

    // Already loaded — render immediately
    if (_activeCourse) {
      _renderCourse(_activeCourse);
    } else {
      _renderHome();
    }
  }

  function close() {
    _isOpen = false;
    var overlay = document.getElementById('library-overlay');
    if (overlay) overlay.classList.remove('open');
    // Reset to home on close so next open is always fresh
    _activeCourse = null;
    _searchQuery = '';
  }

  /* ----------------------------------------------------------
     RENDER — LOADING STATE
  ---------------------------------------------------------- */
  function _renderLoading() {
    var body = document.getElementById('library-body');
    if (!body) return;
    body.innerHTML =
      '<div class="lib-loading">' +
        '<div class="lib-spinner"></div>' +
        '<div class="lib-loading-text">Loading library\u2026</div>' +
      '</div>';
  }

  /* ----------------------------------------------------------
     RENDER — ERROR STATE
  ---------------------------------------------------------- */
  function _renderError(msg) {
    var body = document.getElementById('library-body');
    if (!body) return;
    body.innerHTML =
      '<div class="lib-error">' +
        '<div class="lib-error-icon">📡</div>' +
        '<div class="lib-error-msg">' + _esc(msg) + '</div>' +
        '<button class="lib-retry-btn" onclick="BUKLibrary.open()">Retry</button>' +
      '</div>';
  }

  /* ----------------------------------------------------------
     RENDER — HOME (course list + search bar)
  ---------------------------------------------------------- */
  function _renderHome() {
    var body = document.getElementById('library-body');
    if (!body || !_catalogue) return;

    // Update overlay header to show back-to-home button (hidden at home level)
    _setOverlayHeader('Library Resources', null);

    var courses = _catalogue.courses || [];
    var totalResources = courses.reduce(function (acc, c) {
      return acc + (c.resources || []).length;
    }, 0);

    var availableCount = courses.reduce(function (acc, c) {
      return acc + (c.resources || []).filter(function (r) { return !!r.url; }).length;
    }, 0);

    body.innerHTML =
      // Search bar
      '<div class="lib-search-wrap">' +
        '<div class="lib-search-bar">' +
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>' +
          '<input id="lib-search-input" class="lib-search-input" type="text" placeholder="Search by course, code, or topic\u2026" value="' + _esc(_searchQuery) + '" oninput="BUKLibrary._onSearch(this.value)" autocomplete="off" autocorrect="off" spellcheck="false">' +
          '<button class="lib-search-clear" id="lib-search-clear" onclick="BUKLibrary._clearSearch()" style="display:' + (_searchQuery ? 'flex' : 'none') + '">' +
            '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>' +
          '</button>' +
        '</div>' +
      '</div>' +

      // Stats strip
      '<div class="lib-stats">' +
        '<span class="lib-stat"><strong>' + totalResources + '</strong> resources</span>' +
        '<span class="lib-stat-dot"></span>' +
        '<span class="lib-stat"><strong>' + availableCount + '</strong> available</span>' +
        '<span class="lib-stat-dot"></span>' +
        '<span class="lib-stat"><strong>' + courses.length + '</strong> courses</span>' +
      '</div>' +

      // Course cards or search results
      '<div id="lib-content">' +
        _renderCourseCards(courses) +
      '</div>';

    // If there was an active search, run it
    if (_searchQuery) {
      setTimeout(function () { _onSearch(_searchQuery); }, 0);
    }
  }

  function _renderCourseCards(courses) {
    if (!courses.length) return '<div class="lib-empty">No courses available yet.</div>';

    return courses.map(function (course) {
      var resources = course.resources || [];
      var available = resources.filter(function (r) { return !!r.url; }).length;
      var total     = resources.length;

      // Count by type
      var typeCounts = {};
      resources.forEach(function (r) {
        typeCounts[r.type] = (typeCounts[r.type] || 0) + 1;
      });

      var typePills = Object.keys(typeCounts).map(function (t) {
        var meta = TYPE_META[t] || { label: t, icon: '📄' };
        return '<span class="lib-type-pill">' + meta.icon + ' ' + typeCounts[t] + '</span>';
      }).join('');

      var progressPct = total > 0 ? Math.round((available / total) * 100) : 0;

      return '<div class="lib-course-card" onclick="BUKLibrary._openCourse(\'' + _esc(course.id) + '\')">' +
        '<div class="lib-course-top">' +
          '<div class="lib-course-code">' + _esc(course.code) + '</div>' +
          '<div class="lib-course-arrow">' +
            '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>' +
          '</div>' +
        '</div>' +
        '<div class="lib-course-name">' + _esc(course.name) + '</div>' +
        '<div class="lib-course-faculty">' + _esc(course.faculty) + '</div>' +
        '<div class="lib-course-pills">' + typePills + '</div>' +
        '<div class="lib-course-progress">' +
          '<div class="lib-progress-bar"><div class="lib-progress-fill" style="width:' + progressPct + '%"></div></div>' +
          '<div class="lib-progress-label">' + available + ' / ' + total + ' available</div>' +
        '</div>' +
      '</div>';
    }).join('');
  }

  /* ----------------------------------------------------------
     RENDER — COURSE DETAIL VIEW
  ---------------------------------------------------------- */
  function _openCourse(courseId) {
    _activeCourse = courseId;
    _renderCourse(courseId);
  }

  function _renderCourse(courseId) {
    var body = document.getElementById('library-body');
    if (!body || !_catalogue) return;

    var course = (_catalogue.courses || []).find(function (c) { return c.id === courseId; });
    if (!course) return;

    // Override header with back button
    _setOverlayHeader(course.name, function () {
      _activeCourse = null;
      _renderHome();
    });

    var resources = course.resources || [];

    // Group resources by type
    var grouped = {};
    var typeOrder = ['past_questions', 'lecture_notes', 'lab_manual', 'handout', 'textbook', 'handbook'];
    resources.forEach(function (r) {
      if (!grouped[r.type]) grouped[r.type] = [];
      grouped[r.type].push(r);
    });

    var html = '<div class="lib-course-header-strip">' +
      '<div class="lib-course-code-large">' + _esc(course.code) + '</div>' +
      '<div class="lib-course-name-large">' + _esc(course.name) + '</div>' +
      '<div class="lib-course-faculty-large">' + _esc(course.faculty) + '</div>' +
    '</div>';

    var hasContent = false;
    typeOrder.forEach(function (type) {
      if (!grouped[type] || !grouped[type].length) return;
      hasContent = true;
      var meta = TYPE_META[type] || { label: type, icon: '📄', color: '#BDE8F5' };
      html += '<div class="lib-type-section">' +
        '<div class="lib-type-heading">' +
          '<span class="lib-type-icon">' + meta.icon + '</span>' +
          '<span>' + meta.label + '</span>' +
          '<span class="lib-type-count">' + grouped[type].length + '</span>' +
        '</div>';

      grouped[type].forEach(function (res) {
        html += _renderResourceRow(res);
      });

      html += '</div>';
    });

    if (!hasContent) {
      html += '<div class="lib-empty">No resources yet for this course.<br>Check back soon.</div>';
    }

    body.innerHTML = html;
  }

  function _renderResourceRow(res) {
    var isAvailable = !!res.url;
    var isExternal  = isAvailable && (res.type === 'textbook' || _isExternalUrl(res.url));
    var sizeLabel   = res.size_kb ? _formatSize(res.size_kb) : '';
    var sessionLabel = res.session ? res.session : '';
    var meta = [sessionLabel, sizeLabel].filter(Boolean).join(' · ');

    if (isAvailable) {
      var clickHandler = isExternal
        ? 'BUKLibrary._openExternal(\'' + _esc(res.url) + '\')'
        : 'BUKLibrary._openPDF(\'' + _esc(res.url) + '\',\'' + _esc(res.title) + '\')';

      return '<div class="lib-resource available" onclick="' + clickHandler + '">' +
        '<div class="lib-resource-info">' +
          '<div class="lib-resource-title">' + _esc(res.title) + '</div>' +
          (meta ? '<div class="lib-resource-meta">' + _esc(meta) + '</div>' : '') +
        '</div>' +
        '<div class="lib-resource-action ' + (isExternal ? 'external' : 'download') + '">' +
          (isExternal
            ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>'
            : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>'
          ) +
        '</div>' +
      '</div>';
    }

    // Not yet available
    return '<div class="lib-resource">' +
      '<div class="lib-resource-info">' +
        '<div class="lib-resource-title">' + _esc(res.title) + '</div>' +
        (meta ? '<div class="lib-resource-meta">' + _esc(meta) + '</div>' : '') +
      '</div>' +
      '<div class="lib-soon-badge">Soon</div>' +
    '</div>';
  }

  /* ----------------------------------------------------------
     SEARCH
  ---------------------------------------------------------- */
  function _onSearch(query) {
    _searchQuery = query.trim();
    var clearBtn = document.getElementById('lib-search-clear');
    if (clearBtn) clearBtn.style.display = _searchQuery ? 'flex' : 'none';

    var content = document.getElementById('lib-content');
    if (!content) return;

    if (!_searchQuery) {
      content.innerHTML = _renderCourseCards(_catalogue.courses || []);
      return;
    }

    var results;
    if (_fuseIndex && typeof _fuseIndex.search === 'function') {
      results = _fuseIndex.search(_searchQuery).map(function (r) { return r.item; });
    } else {
      // Fallback: simple includes filter
      var ql = _searchQuery.toLowerCase();
      results = (_fuseIndex && _fuseIndex._flat || []).filter(function (r) {
        return (r.title + r.courseCode + r.courseName + r.tags).toLowerCase().indexOf(ql) !== -1;
      });
    }

    if (!results.length) {
      content.innerHTML = '<div class="lib-empty"><strong>No results for "' + _esc(_searchQuery) + '"</strong><br>Try a course code, name, or keyword.</div>';
      return;
    }

    // Group search results by course
    var byCourse = {};
    results.forEach(function (r) {
      if (!byCourse[r.courseId]) byCourse[r.courseId] = { courseCode: r.courseCode, courseName: r.courseName, resources: [] };
      byCourse[r.courseId].resources.push(r);
    });

    var html = '<div class="lib-search-results-label">' + results.length + ' result' + (results.length !== 1 ? 's' : '') + '</div>';

    Object.keys(byCourse).forEach(function (courseId) {
      var group = byCourse[courseId];
      // Find full resource objects from catalogue
      var course = (_catalogue.courses || []).find(function (c) { return c.id === courseId; });
      if (!course) return;

      html += '<div class="lib-search-group">' +
        '<div class="lib-search-group-label" onclick="BUKLibrary._openCourse(\'' + _esc(courseId) + '\')">' +
          '<span class="lib-search-group-code">' + _esc(group.courseCode) + '</span>' +
          '<span class="lib-search-group-name">' + _esc(group.courseName) + '</span>' +
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><polyline points="9 18 15 12 9 6"/></svg>' +
        '</div>';

      group.resources.forEach(function (r) {
        // Get full resource from course
        var fullRes = (course.resources || []).find(function (x) { return x.id === r.id; });
        if (fullRes) html += _renderResourceRow(fullRes);
      });

      html += '</div>';
    });

    content.innerHTML = html;
  }

  function _clearSearch() {
    _searchQuery = '';
    var input = document.getElementById('lib-search-input');
    if (input) { input.value = ''; input.focus(); }
    var clearBtn = document.getElementById('lib-search-clear');
    if (clearBtn) clearBtn.style.display = 'none';
    var content = document.getElementById('lib-content');
    if (content) content.innerHTML = _renderCourseCards(_catalogue.courses || []);
  }

  /* ----------------------------------------------------------
     PDF VIEWER — in-app via iframe (avoids tab-closing issues
     on mobile browsers when opening PDFs in new tabs)
  ---------------------------------------------------------- */
  function _openPDF(url, title) {
    // Ensure the PDF viewer overlay exists
    var viewer = document.getElementById('lib-pdf-viewer');
    if (!viewer) {
      viewer = document.createElement('div');
      viewer.id = 'lib-pdf-viewer';
      viewer.className = 'lib-pdf-overlay';
      viewer.innerHTML =
        '<div class="lib-pdf-header">' +
          '<button class="lib-pdf-close" onclick="BUKLibrary._closePDF()">' +
            '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>' +
          '</button>' +
          '<div class="lib-pdf-title" id="lib-pdf-title"></div>' +
          '<a class="lib-pdf-download" id="lib-pdf-download" target="_blank" rel="noopener" title="Open in browser / download">' +
            '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>' +
          '</a>' +
        '</div>' +
        '<div class="lib-pdf-body">' +
          '<iframe id="lib-pdf-iframe" class="lib-pdf-frame" src="" title="Document viewer"></iframe>' +
          '<div class="lib-pdf-fallback" id="lib-pdf-fallback" style="display:none">' +
            '<div class="lib-pdf-fallback-icon">📄</div>' +
            '<div class="lib-pdf-fallback-msg">Preview not available in this browser.<br>Tap below to open or download the file.</div>' +
            '<a id="lib-pdf-fallback-link" class="lib-pdf-open-btn" target="_blank" rel="noopener">Open PDF</a>' +
          '</div>' +
        '</div>';
      document.body.appendChild(viewer);

      // Handle iframe load failure (common on mobile)
      var iframe = document.getElementById('lib-pdf-iframe');
      iframe.addEventListener('error', _showPDFFallback);
      // Timeout — if iframe doesn't signal load in 8s, show fallback
      iframe._loadTimer = null;
    }

    var iframe   = document.getElementById('lib-pdf-iframe');
    var titleEl  = document.getElementById('lib-pdf-title');
    var dlLink   = document.getElementById('lib-pdf-download');
    var fallback = document.getElementById('lib-pdf-fallback');
    var fallbackLink = document.getElementById('lib-pdf-fallback-link');

    // Reset state
    fallback.style.display = 'none';
    iframe.style.display   = 'block';
    titleEl.textContent    = title || 'Document';
    dlLink.href            = url;
    fallbackLink.href      = url;

    // IMPORTANT: on mobile Chrome/Safari, embedding a cross-origin PDF
    // in an iframe often fails silently. We use Google Docs viewer as
    // a reliable fallback renderer — it works for public URLs.
    var isR2 = url.indexOf('r2.dev') !== -1 || url.indexOf('cloudflare') !== -1;
    var viewerUrl;
    if (isR2) {
      // Cloudflare R2 public URLs: try direct embed first
      viewerUrl = url;
    } else {
      // For any other URL, use Google Docs viewer (handles most PDFs on mobile)
      viewerUrl = 'https://docs.google.com/viewer?url=' + encodeURIComponent(url) + '&embedded=true';
    }

    iframe.src = viewerUrl;

    // Fallback timer — if nothing loads in 10s, show the open-button fallback
    clearTimeout(iframe._loadTimer);
    iframe._loadTimer = setTimeout(_showPDFFallback, 10000);
    iframe.onload = function () { clearTimeout(iframe._loadTimer); };

    viewer.classList.add('open');
  }

  function _showPDFFallback() {
    var iframe   = document.getElementById('lib-pdf-iframe');
    var fallback = document.getElementById('lib-pdf-fallback');
    if (iframe)   iframe.style.display   = 'none';
    if (fallback) fallback.style.display = 'flex';
  }

  function _closePDF() {
    var viewer = document.getElementById('lib-pdf-viewer');
    if (viewer) viewer.classList.remove('open');
    // Clear iframe src to stop download
    var iframe = document.getElementById('lib-pdf-iframe');
    if (iframe) { clearTimeout(iframe._loadTimer); iframe.src = ''; }
  }

  function _openExternal(url) {
    window.open(url, '_blank', 'noopener,noreferrer');
  }

  /* ----------------------------------------------------------
     OVERLAY HEADER CONTROL
     Replaces the static ov-title/ov-back with dynamic content
  ---------------------------------------------------------- */
  function _setOverlayHeader(title, backFn) {
    var header = document.querySelector('#library-overlay .ov-header');
    if (!header) return;
    header.innerHTML =
      '<button class="ov-back" onclick="' + (backFn ? 'BUKLibrary._navBack()' : "closeOverlay('library-overlay')") + '">' +
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>' +
      '</button>' +
      '<span class="ov-title">' + _esc(title) + '</span>';
    // Store callback for back navigation
    BUKLibrary._backFn = backFn;
  }

  function _navBack() {
    if (BUKLibrary._backFn) {
      BUKLibrary._backFn();
      BUKLibrary._backFn = null;
    }
  }

  /* ----------------------------------------------------------
     UTILITIES
  ---------------------------------------------------------- */
  function _esc(str) {
    if (str === null || str === undefined) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function _formatSize(kb) {
    if (kb < 1024) return kb + ' KB';
    return (kb / 1024).toFixed(1) + ' MB';
  }

  function _isExternalUrl(url) {
    if (!url) return false;
    try {
      var u = new URL(url);
      return u.hostname !== location.hostname;
    } catch (e) {
      return false;
    }
  }

  /* ----------------------------------------------------------
     PUBLIC API
  ---------------------------------------------------------- */
  return {
    init:          init,
    open:          open,
    close:         close,
    _openCourse:   _openCourse,
    _onSearch:     _onSearch,
    _clearSearch:  _clearSearch,
    _openPDF:      _openPDF,
    _closePDF:     _closePDF,
    _openExternal: _openExternal,
    _navBack:      _navBack,
    _backFn:       null
  };

}());
