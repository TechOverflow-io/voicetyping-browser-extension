/* LanguageTool WebExtension
 * Copyright (C) 2017 Daniel Naber (http://www.danielnaber.de)
 *
 * This library is free software; you can redistribute it and/or
 * modify it under the terms of the GNU Lesser General Public
 * License as published by the Free Software Foundation; either
 * version 2.1 of the License, or (at your option) any later version.
 *
 * This library is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU
 * Lesser General Public License for more details.
 *
 * You should have received a copy of the GNU Lesser General Public
 * License along with this library; if not, write to the Free Software
 * Foundation, Inc., 51 Franklin St, Fifth Floor, Boston, MA  02110-1301
 * USA
 */

/* global activeElement, setActiveElement */

const REMIND_WRAPPER_CLASS = "lt-marker-container";
const POPUP_CONTENT_CLASS = "ltaddon-popup-content";
const BTN_CLASS = "lt-buttons";
const REMIND_BTN_CLASS = "lt-remind-btn";
const CHECK_DONE_BTN_CLASS = "lt-check-done-btn";
const LOADING_BTN_CLASS = "lt-check-loading-btn";
const VOICE_TYPING_BTN_CLASS = "vt-btn";
const ERROR_BTN_CLASS = "lt-error-btn";
const DISABLE_BTN_CLASS = "lt-disable-btn";
const AUTO_CHECK_BTN_CLASS = "lt-auto-check-btn";
const AUTO_CHECK_OFF_BTN_CLASS = "lt-auto-check-off-btn";
const AUTO_CHECK_MANUAL_BTN_CLASS = "lt-auto-check-manual-btn";
const MARGIN_TO_CORNER = 8;
const REMIND_BTN_SIZE = 16;
const CLEAN_TIMEOUT_MILLIS = 200;
const BG_CHECK_TIMEOUT_MILLIS = 1500;

const DOMAIN_SETTINGS = {
  "twitter.com": {left: -22}
};

let wrapperId = 0;
let disableOnDomain = false;
let autoCheckOnDomain = false;
let ignoreQuotedLines = true;
let autoCheck = false;
let ignoreCheckOnDomains = [];
let totalErrorOnCheckText = -1; // -1 = not checking yet
let lastCheckResult = { markupList: [], result: {}, total: -1, isProcess: false, success: true };

const activeElementHandler = ally.event.activeElement();
const port = chrome.runtime.connect({name: "LanguageTool"});

function isGmail() {
  const currentUrl = window.location.href;
  const { hostname } = new URL(currentUrl);
  return hostname === "mail.google.com";
}

function cleanErrorMessage(msg) {
  const position = msg.lastIndexOf('Error:');
  if (position !== -1) {
    return msg.substr(position + 7);
  }
  return msg;
}

function isAutoCheckEnable() {
  const currentUrl = window.location.href;
  const { hostname } = new URL(currentUrl);
  return autoCheckOnDomain || (autoCheck && !ignoreCheckOnDomains.includes(hostname));
}

/** event handlers */

function checkErrorMenu(evt) {
  evt.stopPropagation();
  evt.preventDefault();
  const currentUrl = window.location.href;
  const textAreaElement = activeElement();
  if (textAreaElement) {
    if (textAreaElement.setActive) {
      textAreaElement.setActive();
    } else {
      textAreaElement.focus();
    }
  }
  const popupWidth = 450;
  const popupHeight = Math.min(window.innerHeight * 80 / 100, 600);
  $.featherlight.defaults.closeIcon = "&nbsp;";
  $.featherlight({
    iframe: `${chrome.runtime.getURL("popup.html")}?pageUrl=${currentUrl}`,
    iframeWidth: popupWidth,
    iframeHeight: popupHeight,
    namespace: "ltaddon-popup",
    beforeOpen: () => {
      const popupContainers = document.getElementsByClassName(POPUP_CONTENT_CLASS);
      for (let counter = 0; counter < popupContainers.length; counter++) {
        const popupContainer = popupContainers[counter];
        popupContainer.style.minWidth = `${popupWidth}px`;
        popupContainer.style.minHeight = `${popupHeight}px`;
      }
    },
    afterOpen: () => {
      const currentPopup = $.featherlight.current();
      currentPopup.$content.focus();
    }
  });
}

function removeAllButtons() {
  console.log('removeAllButtons')
  const btns = document.getElementsByClassName(REMIND_WRAPPER_CLASS);
  for (let counter = 0; counter < btns.length; counter++) {
    const btn = btns[counter];
    btn.parentNode.removeChild(btn);
  }
}

function disableMenu(evt) {
  evt.preventDefault();
  disableOnDomain = true;
  removeAllButtons();
  Tools.getStorage().get(
    {
      disabledDomains: []
    },
    items => {
      const currentUrl = window.location.href;
      const { hostname } = new URL(currentUrl);
      items.disabledDomains.push(hostname);
      Tools.getStorage().set({
        disabledDomains: Array.from(new Set(items.disabledDomains))
      });
      Tools.track(hostname, "reminder deactivated");
    }
  );
}

function manualAutoCheck(evt) {
  evt.preventDefault();
  lastCheckResult = Object.assign({},lastCheckResult, { markupList: [], result: {}, total: -1, isProcess: false, success: true });
  const currentUrl = window.location.href;
  const { hostname } = new URL(currentUrl);
  Tools.getStorage().get(
    {
      ignoreCheckOnDomains: ignoreCheckOnDomains
    },
    items => {
      if (!items.ignoreCheckOnDomains.includes(hostname)) {
        items.ignoreCheckOnDomains.push(hostname);
        ignoreCheckOnDomains = Array.from(new Set(items.ignoreCheckOnDomains));
        Tools.getStorage().set({
          ignoreCheckOnDomains
        });
      } else {
        ignoreCheckOnDomains = items.ignoreCheckOnDomains.filter(item => item !== hostname);
        Tools.getStorage().set({
          ignoreCheckOnDomains
        });
      }
      const textAreaElement = activeElement();
      if (textAreaElement) {
        if (textAreaElement.setActive) {
          textAreaElement.setActive();
        } else {
          textAreaElement.focus();
        }
        positionMarkerOnChangeSize();
      }
  });
}

function autoCheckMenu(evt) {
  evt.preventDefault();
  autoCheckOnDomain = !autoCheckOnDomain;
  if (!autoCheckOnDomain) {
    lastCheckResult = Object.assign({},lastCheckResult, { markupList: [], result: {}, total: -1, isProcess: false, success: true });
  }
  const textAreaElement = activeElement();
  if (textAreaElement) {
    if (textAreaElement.setActive) {
      textAreaElement.setActive();
    } else {
      textAreaElement.focus();
    }

    if (autoCheckOnDomain) {
      const { markupList, metaData } = getMarkupListFromElement(textAreaElement);
      checkTextFromMarkup({ markupList, metaData }).then(result => {
        if (result) {
          showMatchedResultOnMarker(result);
        }
      }).catch(error => {
        console.error(error);
        Tools.track(window.location.href, "auto-check error", error.message);
      });
    } else {
      positionMarkerOnChangeSize();
    }
  }

  Tools.getStorage().get(
    {
      autoCheckOnDomains: []
    },
    items => {
      const currentUrl = window.location.href;
      const { hostname } = new URL(currentUrl);
      if (autoCheckOnDomain) {
        items.autoCheckOnDomains.push(hostname);
        Tools.getStorage().set({
          autoCheckOnDomains: Array.from(new Set(items.autoCheckOnDomains))
        });
      } else {
        Tools.getStorage().set({
          autoCheckOnDomains: items.autoCheckOnDomains.filter(item => item !== hostname)
        });
      }

      if (autoCheckOnDomain) {
        Tools.track(hostname, "auto-check activated");
      } else {
        Tools.track(hostname, "auto-check deactivated");
      }
    }
  );
}

/** DOM manipulate */

function styleRemindButton(btn, position, num) {
  const { top, left, offsetHeight, offsetWidth } = position;
  btn.style.position = "absolute";
  if (isGmail()) {
    const tables = document.querySelectorAll("table#undefined");
    const activeTable = Array.prototype.find.call(tables, table =>
      isDescendant(table, document.activeElement)
    );
    // find parent of active table
    const allTables = document.getElementsByTagName("table");
    const gmailComposeToolbarHeight = 155;
    for (let counter = allTables.length - 1; counter > 0; counter--) {
      const parentTable = allTables[counter];
      if (isDescendant(parentTable, activeTable)) {
        let topPosition = offset(parentTable).top;
        if (topPosition < gmailComposeToolbarHeight) {
          topPosition = gmailComposeToolbarHeight;
        }
        btn.style.top = `${topPosition}px`;
        break;
      }
    }
  } else {
    btn.style.top = `${top + offsetHeight - REMIND_BTN_SIZE - MARGIN_TO_CORNER}px`;
  }
  const { hostname } = new URL(window.location.href);
  const leftTmp = DOMAIN_SETTINGS[hostname] ? left + DOMAIN_SETTINGS[hostname].left : left;
  btn.style.left = `${leftTmp + offsetWidth - (REMIND_BTN_SIZE + MARGIN_TO_CORNER)*num}px`;
}

function remindLanguageToolButton(clickHandler, position, num) {

  // const btn = document.createElement(BTN_CLASS, { is: "a" });
  // btn.className = `${BTN_CLASS} ${VOICE_TYPING_BTN_CLASS}`;

  const btn = document.createElement('div');
  btn.id = 'voicely-group'

  btn.innerHTML = `
    <div class="vl-country-flags">
      <div id="vl-country-flags" class="select">
      </div>
      <div id="vl-country-flags-drop" class="dropdown">
        <ul>
          <li>
            <i class="flag:US"></i>
          </li>
          <li>
            <i class="flag:GB"></i>
          </li>
          <li>
            <i class="flag:AU"></i>
          </li>
          <li>
            <i class="flag:CA"></i>
          </li>
          <li>
            <i class="flag:DE"></i>
          </li>
        </ul>
      </div>
    </div>

    <svg id="voicely-mic-svg" version="1.1" viewBox="0.0 0.0 603.9501312335958 603.994750656168" fill="none"
      stroke="none" stroke-linecap="square" stroke-miterlimit="10" xmlns:xlink="http://www.w3.org/1999/xlink"
      xmlns="http://www.w3.org/2000/svg">
      <clipPath id="p.0">
        <path d="m0 0l603.95013 0l0 603.99475l-603.95013 0l0 -603.99475z" clip-rule="nonzero" />
      </clipPath>
      <g clip-path="url(#p.0)">
        <path fill="#000000" fill-opacity="0.0" d="m0 0l603.95013 0l0 603.99475l-603.95013 0z" fill-rule="evenodd" />
        <path fill="#df072e"
          d="m0 302.01575l0 0c0 -166.79869 135.21706 -302.01575 302.01575 -302.01575l0 0c80.09955 0 156.91846 31.819426 213.55737 88.45837c56.638977 56.63894 88.458374 133.45782 88.458374 213.55737l0 0c0 166.7987 -135.21704 302.01575 -302.01575 302.01575l0 0c-166.79869 0 -302.01575 -135.21704 -302.01575 -302.01575z"
          fill-rule="evenodd" />
        <path fill="#000000" fill-opacity="0.0" d="m154.10498 70.46456l295.82147 0l0 463.10245l-295.82147 0z"
          fill-rule="evenodd" />
        <g transform="matrix(0.4725582677165354 0.0 0.0 0.4725535433070866 154.10498687664042 70.46456456692914)">
          <clipPath id="p.1">
            <path d="m0 2.842171E-14l626.0 0l0 980.0l-626.0 0z" clip-rule="evenodd" />
          </clipPath>
          <image clip-path="url(#p.1)" fill="#000" width="626.0" height="980.0" x="0.0" y="0.0"
            preserveAspectRatio="none"
            xlink:href="data:image/png;base64,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" />
        </g>
      </g>
    </svg>
  `

  // if (isAutoCheckEnable()) {
  //    if (!lastCheckResult.isTyping && lastCheckResult.isProcess) { // show loading on calling check api
  //     btn.className = `${BTN_CLASS} ${LOADING_BTN_CLASS}`;
  //     btn.setAttribute("tooltip", chrome.i18n.getMessage("reminderIconTitle"));
  //     btn.innerHTML = `<div class="lt-sk-three-bounce"><div class="lt-sk-child lt-sk-bounce1"></div><div class="lt-sk-child lt-sk-bounce2"></div><div class="lt-sk-child lt-sk-bounce3"></div></div>`;
  //    } else {
  //     if (lastCheckResult.success) {
  //       if (totalErrorOnCheckText > 0) {
  //         btn.className = `${BTN_CLASS} ${ERROR_BTN_CLASS}`;
  //         const tooltip = totalErrorOnCheckText === 1 ? chrome.i18n.getMessage("foundAErrorOnCheckText",[totalErrorOnCheckText]) : chrome.i18n.getMessage("foundErrorsOnCheckText",[totalErrorOnCheckText]);
  //         btn.setAttribute("tooltip", tooltip);
  //         btn.innerText = totalErrorOnCheckText > 9 ? "9+" : totalErrorOnCheckText;
  //       } else if (totalErrorOnCheckText === 0) {
  //         btn.className = `${BTN_CLASS} ${CHECK_DONE_BTN_CLASS}`;
  //         btn.setAttribute("tooltip", chrome.i18n.getMessage("noErrorsFound"));
  //       } else {
  //         btn.className = `${BTN_CLASS} ${REMIND_BTN_CLASS}`;
  //         btn.className = `${BTN_CLASS} ${REMIND_BTN_CLASS}`;
  //         btn.setAttribute("tooltip", chrome.i18n.getMessage("reminderIconTitle"));
  //       }
  //     } else {
  //       assignErrorStyle(btn, cleanErrorMessage(lastCheckResult.errorMessage));
  //     }
  //    }
  // } else {
  //   btn.className = `${BTN_CLASS} ${REMIND_BTN_CLASS}`;
  //   btn.setAttribute("tooltip", chrome.i18n.getMessage("reminderIconTitle"));
  // }

  // btn.onclick = clickHandler;
  // btn.onmouseover = function() {
  //   if (chrome.i18n.getMessage("reminderIconTitle") === undefined) {
  //     // this happens after first installation and after add-on update
  //     assignErrorStyle(btn, "Page reload needed to make text checking work");
  //   }
  // };
  styleRemindButton(btn, position, num);
  countryDropdown('#vl-country-flags', function (selected, drop) {
    $('#voicely-group').mouseleave(function() {
      selected.removeClass('open')
      drop.hide()
    })
  })
  return btn;
}

function assignErrorStyle(btn, msg) {
  btn.className = `${BTN_CLASS} ${ERROR_BTN_CLASS}`;
  btn.setAttribute("tooltip", msg);
  btn.innerText = "E";
}

function disableLanguageToolButton(clickHandler, position, num) {
  const { top, left, offsetHeight, offsetWidth } = position;
  const btn = document.createElement(BTN_CLASS, { is: "a" });
  btn.onclick = clickHandler;
  btn.className = `${BTN_CLASS} ${DISABLE_BTN_CLASS}`;
  btn.setAttribute(
    "tooltip",
    chrome.i18n.getMessage("disableForThisDomainTitle")
  );
  styleRemindButton(btn, position, num);
  return btn;
}

function autoCheckLanguageToolButton(clickHandler, position, num) {
  const { top, left, offsetHeight, offsetWidth } = position;
  const btn = document.createElement(BTN_CLASS, { is: "a" });
  btn.onclick = clickHandler;
  if (autoCheck) {
     const { hostname } = new URL(window.location.href);
     if (ignoreCheckOnDomains.includes(hostname)) {
        btn.className = `${BTN_CLASS} ${AUTO_CHECK_BTN_CLASS}`;
        btn.setAttribute(
            "tooltip",
            chrome.i18n.getMessage("autoCheckOnDesc")
          );
     } else {
        btn.className = `${BTN_CLASS} ${AUTO_CHECK_MANUAL_BTN_CLASS}`;
        btn.setAttribute(
          "tooltip",
          chrome.i18n.getMessage("autoCheckOffDesc")
        );
     }
  } else {
    if (!autoCheckOnDomain) {
      btn.className = `${BTN_CLASS} ${AUTO_CHECK_BTN_CLASS}`;
      btn.setAttribute(
        "tooltip",
        chrome.i18n.getMessage("autoCheckForThisDomainTitle")
      );
    } else {
      btn.className = `${BTN_CLASS} ${AUTO_CHECK_OFF_BTN_CLASS}`;
      btn.setAttribute(
        "tooltip",
        chrome.i18n.getMessage("autoCheckForOffThisDomainTitle")
      );
    }
  }
  styleRemindButton(btn, position, num);
  return btn;
}

function textAreaWrapper(textElement, btnElements) {
  console.log('in textAreaWrapper');
  const wrapper = document.createElement(REMIND_WRAPPER_CLASS, { is: 'div' });
  wrapper.className = REMIND_WRAPPER_CLASS;
  wrapper.id = wrapperId;
  wrapper.style.position = "absolute";
  wrapper.style.top = "0px";
  wrapper.style.left = "0px";
  wrapper.style.zIndex = "999999";
  btnElements.forEach(btnElement => {
    wrapper.appendChild(btnElement);
  });
  document.body.appendChild(wrapper);
}

function insertLanguageToolIcon(element) {
  const { offsetHeight, offsetWidth } = element;
  const { top } = element.getBoundingClientRect();
  const offsetHeightForLongText = window.innerHeight - top - 10;
  const position = Object.assign({}, offset(element), {
    offsetHeight: offsetHeight > window.innerHeight && offsetHeightForLongText < offsetHeight ? offsetHeightForLongText : offsetHeight,
    offsetWidth
  });
  wrapperId = `textarea-wrapper-${Date.now()}`;
  const maxToolTipWidth = 200;
  injectTooltipStyle(Math.min(offsetWidth, maxToolTipWidth));

  const btns = [
    remindLanguageToolButton(checkErrorMenu, position, 1),
  ];

  // if (autoCheck) {
  //   btns.push(autoCheckLanguageToolButton(manualAutoCheck, position, 2));
  // } else {
  //   btns.push(autoCheckLanguageToolButton(autoCheckMenu, position, 2));
  // }
  // btns.push(disableLanguageToolButton(disableMenu, position, 3));

  console.log('LT Icon -> ', element)

  textAreaWrapper(element, btns);
}

/**
 * show marker on element
 * @param DOMElement focusElement
 */
function showMarkerOnEditor(focusElement) {
  // console.log('in showMarkerOnEditor', focusElement)
  if (isEditorElement(focusElement)) {
    console.log('showMarkerOnEditor');
    removeAllButtons();
    setActiveElement(focusElement);
    if (!isHiddenElement(focusElement) && !disableOnDomain) {
      insertLanguageToolIcon(focusElement);
    }
  }
}

// detect on window resize, scroll
let ticking = false;
let lastScrollPosition = 0;
function positionMarkerOnChangeSize() {
  lastScrollPosition = window.scrollY;
  if (!ticking) {
    window.requestAnimationFrame(() => {
      console.log('window.requestAnimationFrame');
      // removeAllButtons();
      if (!disableOnDomain && isShowOnViewPort(document.activeElement)) {
        showMarkerOnEditor(document.activeElement);
      }
      ticking = false;
    });
    ticking = true;
  }
}

function showMatchedResultOnMarker(result) {
  if (result && result.matches && result.matches.length > 0) {
    const language = DOMPurify.sanitize(result.language.name);
    const languageCode = DOMPurify.sanitize(result.language.code);
    const shortLanguageCode = getShortCode(languageCode);
    let matchesCount = 0;
    let matches = [];
    const uniquePositionMatches = [];
    let prevErrStart = -1;
    let prevErrLen = -1;
    for (let i = result.matches.length - 1; i >= 0; i--) {
      const m = result.matches[i];
      const errStart = parseInt(m.offset);
      const errLen = parseInt(m.length);
      if (errStart !== prevErrStart || errLen !== prevErrLen) {
        uniquePositionMatches.push(m);
        prevErrStart = errStart;
        prevErrLen = errLen;
      }
    }
    uniquePositionMatches.reverse();
    matches = uniquePositionMatches;
    const ignoredRuleCounts = {};
    const ruleIdToDesc = {};
    Tools.getUserSettingsForRender(
    items => {
      const { dictionary, ignoredRules, ignoreQuotedLines } = items;
      for (let m of matches) {
        // these values come from the server, make sure they are ints:
        const errStart = parseInt(m.context.offset);
        const errLen = parseInt(m.length);
        // these string values come from the server and need to be sanitized
        // as they will be inserted with innerHTML:
        const contextSanitized = DOMPurify.sanitize(m.context.text);
        const ruleIdSanitized = DOMPurify.sanitize(m.rule.id);
        const messageSanitized = DOMPurify.sanitize(m.message);
        ruleIdToDesc[ruleIdSanitized] = DOMPurify.sanitize(m.rule.description);
        const wordSanitized = contextSanitized.substr(errStart, errLen);
        let ignoreError = false;
        if (isSpellingError(m)) {
          // Also accept uppercase versions of lowercase words in personal dict:
          const knowToDict = dictionary.indexOf(wordSanitized) !== -1;
          if (knowToDict) {
            ignoreError = true;
          } else if (!knowToDict && Tools.startWithUppercase(wordSanitized)) {
            ignoreError = dictionary.indexOf(Tools.lowerCaseFirstChar(wordSanitized)) !== -1;
          }
        } else {
          ignoreError = ignoredRules.find(k => k.id === ruleIdSanitized && k.language === shortLanguageCode);
        }
        if (!ignoreError) {
          matchesCount++;
        }
      }
      totalErrorOnCheckText = matchesCount;
      lastCheckResult = Object.assign({}, lastCheckResult, { total: matchesCount });
      positionMarkerOnChangeSize();
    });
  } else {
    totalErrorOnCheckText = 0;
    lastCheckResult = Object.assign({}, lastCheckResult, { total: 0, result: {}, markupList: [] });
    positionMarkerOnChangeSize();
  }
}

function checkTextFromMarkup({ markupList, metaData }) {
  if (isSameObject(markupList,lastCheckResult.markupList)) {
    return Promise.resolve({ result: lastCheckResult.result });
  }
  lastCheckResult = Object.assign({}, lastCheckResult, { markupList, isProcess: true, isTyping: false });
  positionMarkerOnChangeSize();
  if (!isAutoCheckEnable()) {
    return Promise.resolve({ result: {} });
  }
  port.postMessage({
      action: "checkText",
      data: { markupList, metaData }
  });
  return new Promise((resolve) => {
    port.onMessage.addListener((msg) => {
      if (msg.success) {
        if (!isSameObject(markupList,lastCheckResult.markupList)) {
          totalErrorOnCheckText = -1;
          lastCheckResult = Object.assign({}, lastCheckResult, { result: {}, total: -1, isProcess: false  });
          return resolve({ result: {}, total: -1 });
        }
        lastCheckResult = Object.assign({}, lastCheckResult, msg, { isProcess: false });
        return resolve(msg.result);
      } else {
        const { errorMessage } = msg;
        lastCheckResult = Object.assign({}, lastCheckResult, msg, { result: {}, total: -1, isProcess: false });
        Tools.track(window.location.href, `error on checkTextFromMarkup: ${errorMessage}`);
        return resolve({});
      }
    });
  });
}

function getMarkupListFromElement(element) {
  const pageUrl = window.location.href;
  if (element.tagName === "IFRAME") {
    try {
      if (element
        && element.contentWindow
        && element.contentWindow.document.getSelection()
        && element.contentWindow.document.getSelection().toString() !== "") {
        const text = element.contentWindow.document.getSelection().toString();
        return ({markupList: [{text}], isEditableText: false, metaData: getMetaData(pageUrl)});
      }
    } catch (err) {
      console.error(err);
      Tools.track(pageUrl, `error on getMarkupListFromElement for iframe: ${err.message}`);
    }
  }
  const markupList = getMarkupListOfActiveElement(element);
  return ({markupList, isEditableText: true, metaData: getMetaData(pageUrl)});
}

function elementMarkup(evt) {
  totalErrorOnCheckText = -1;
  lastCheckResult = Object.assign({}, lastCheckResult, { result: {}, markupList: [], total: -1, isProcess: false, isTyping: true });
  return getMarkupListFromElement(evt.target);
}

function observeEditorElement(element) {
  /* global most */
  const { fromEvent, fromPromise, merge } = most;
  // Logs the current value of the searchInput, only after the user stops typing
  let inputText;
  if (element.tagName === 'IFRAME') {
    inputText = fromEvent('input', element.contentWindow).map(elementMarkup).skipRepeatsWith(isSameObject).multicast();
  } else {
    inputText = fromEvent('input', element).map(elementMarkup).skipRepeatsWith(isSameObject).multicast();
  }
  // Empty results list if there is no text
  const emptyResults = inputText.filter(markup => markup.markupList && markup.markupList[0] && markup.markupList[0].text && markup.markupList[0].text.length < 1).constant([]);
  const results = inputText.filter(markup => markup.markupList && markup.markupList[0] && markup.markupList[0].text && markup.markupList[0].text.length > 1)
    .debounce(BG_CHECK_TIMEOUT_MILLIS)
    .map(checkTextFromMarkup)
    .map(fromPromise)
    .switchLatest();
  merge(results, emptyResults).observe(showMatchedResultOnMarker);
}

function bindCheckErrorEventOnElement(currentElement) {
  if (isAutoCheckEnable() && isEditorElement(currentElement)) {
    totalErrorOnCheckText = -1;
    if (!lastCheckResult.isProcess) {
      const { markupList, metaData } = getMarkupListFromElement(currentElement);
      if (!isSameObject(markupList, lastCheckResult.markupList)) {
        checkTextFromMarkup({ markupList, metaData }).then(result => {
          if (result) {
            showMatchedResultOnMarker(result);
          }
        }).catch(error => {
          console.error(error);
          Tools.track(window.location.href, "auto-check error", error.message);
        });
      } else {
        showMatchedResultOnMarker(lastCheckResult.result);
      }
    }

    if (!currentElement.getAttribute("lt-auto-check")) {
        observeEditorElement(currentElement);
        currentElement.setAttribute("lt-auto-check", true);
    }

    // edge case for mail.google.com
    if (isGmail() && document.getElementById(":4")) {
      // scroll element
      const scrollContainerOnGmail = document.getElementById(":4");
      if (!scrollContainerOnGmail.getAttribute("lt-bind-scroll")) {
        scrollContainerOnGmail.addEventListener(
          "scroll",
          positionMarkerOnChangeSize
        );
        scrollContainerOnGmail.setAttribute("lt-bind-scroll", true);
      }
    }
  }
}

function allowToShowMarker(callback) {
  const currentUrl = window.location.href;
  disableOnDomain = Tools.doNotShowMarkerOnUrl(currentUrl);
  if (!disableOnDomain) {
    Tools.getStorage().get(
      {
        disabledDomains: [],
        autoCheckOnDomains: [],
        ignoreCheckOnDomains: [],
        ignoreQuotedLines: true,
        autoCheck: autoCheck,
      },
      items => {
        const { hostname } = new URL(currentUrl);
        autoCheckOnDomain = items.autoCheckOnDomains.includes(hostname);
        disableOnDomain = items.disabledDomains.includes(hostname);
        ignoreQuotedLines = items.ignoreQuotedLines;
        autoCheck = items.autoCheck;
        ignoreCheckOnDomains = items.ignoreCheckOnDomains;
        if (disableOnDomain) {
          console.log('if disableOnDomain');
          removeAllButtons();
        } else {
          callback();
        }
      }
    );
  } else {
    console.log('else');
    removeAllButtons();
    activeElementHandler.disengage();
  }
}

window.addEventListener("resize", positionMarkerOnChangeSize);
window.addEventListener("scroll", positionMarkerOnChangeSize);

function injectLoadingStyle() {
  const style = document.createElement('style');
  style.type = 'text/css';
  style.innerHTML = `
    /* loading */
    .lt-sk-three-bounce {
      margin: 2px auto;
      width: 100%;
      text-align: center; }
      .lt-sk-three-bounce .lt-sk-child {
        width: 5px;
        height: 5px;
        background-color: #333;
        border-radius: 100%;
        display: inline-block;
        -webkit-animation: lt-sk-three-bounce 1.4s ease-in-out 0s infinite both;
                animation: lt-sk-three-bounce 1.4s ease-in-out 0s infinite both; }
      .lt-sk-three-bounce .lt-sk-bounce1 {
        -webkit-animation-delay: -0.32s;
                animation-delay: -0.32s; }
      .lt-sk-three-bounce .lt-sk-bounce2 {
        -webkit-animation-delay: -0.16s;
                animation-delay: -0.16s; }

    @-webkit-keyframes lt-sk-three-bounce {
      0%, 80%, 100% {
        -webkit-transform: scale(0);
                transform: scale(0); }
      40% {
        -webkit-transform: scale(1);
                transform: scale(1); } }

    @keyframes lt-sk-three-bounce {
      0%, 80%, 100% {
        -webkit-transform: scale(0);
                transform: scale(0); }
      40% {
        -webkit-transform: scale(1);
                transform: scale(1); } }
  `;
  document.body.appendChild(style);
}

function injectTooltipStyle(width = 100) {
  const style = document.createElement('style');
  style.type = 'text/css';
  if (width < 100) {
    style.innerHTML = `
      #${wrapperId} .lt-buttons[tooltip]:before {
        min-width: ${width}px;
        bottom: 100%;
        left: 5%;
      }
    `;
  } else {
    style.innerHTML = `
      #${wrapperId} .lt-buttons[tooltip]:before {
        min-width: ${width}px;
      }
    `;
  }
  document.body.appendChild(style);
}

if (
  document.readyState === "complete" ||
  (document.readyState !== "loading" && !document.documentElement.doScroll)
) {
  allowToShowMarker(() => {
    injectLoadingStyle();
    setTimeout(() => {
      if (!disableOnDomain) {
        showMarkerOnEditor(document.activeElement);
        bindCheckErrorEventOnElement(document.activeElement);
      }
    }, 0);
  });
} else {
  document.addEventListener("DOMContentLoaded", () => {
    allowToShowMarker(() => {
      injectLoadingStyle();
      setTimeout(() => {
        if (!disableOnDomain) {
          showMarkerOnEditor(document.activeElement);
          bindCheckErrorEventOnElement(document.activeElement);
        }
      }, 0);
    });
  });
}

// observe the active element to show the marker
let cleanUpTimeout;
document.addEventListener(
  "active-element",
  event => {
    const { focus: focusElement, blur: blurElement } = event.detail;
    if (isHiddenElement(blurElement) && isEditorElement(blurElement)) {
      console.log('isHiddenElement(blurElement)');
      removeAllButtons();
    }
    if (!disableOnDomain) {
      // use timeout for adjust html after rendering DOM
      // try to reposition for some site which is rendering from JS (e.g: Upwork)
      setTimeout(() => {
        showMarkerOnEditor(focusElement);
        bindCheckErrorEventOnElement(focusElement);
      },0);
      //setActiveElement(focusElement);  --> when commented in, I get: SecurityError: Blocked a frame with origin "http://localhost" from accessing a cross-origin frame.

      if (!cleanUpTimeout) {
        cleanUpTimeout = setTimeout(() => {
          if (
            isHiddenElement(document.activeElement) ||
            !isEditorElement(document.activeElement)
          ) {
            console.log('isHiddenElement(document.activeElement)');
            // removeAllButtons();
          }
          cleanUpTimeout = null;
        }, CLEAN_TIMEOUT_MILLIS);
      }

      // show the marker on UI
      setTimeout(() => {
        positionMarkerOnChangeSize();
      },200);
    }
  },
  false
);
