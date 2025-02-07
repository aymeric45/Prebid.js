import {
  buildUrl,
  deepAccess,
  getWindowTop,
  isArray,
  isEmpty,
  isEmptyStr,
  isStr,
  logError,
  logInfo,
  triggerPixel
} from '../src/utils.js';
import {registerBidder} from '../src/adapters/bidderFactory.js';
import {config} from '../src/config.js';
import {BANNER, NATIVE, VIDEO} from '../src/mediaTypes.js';
import {getRefererInfo} from '../src/refererDetection.js';
import {Renderer} from '../src/Renderer.js';
import { convertOrtbRequestToProprietaryNative } from '../src/native.js';
import {getGlobal} from '../src/prebidGlobal.js';
import {getGptSlotInfoForAdUnitCode} from '../libraries/gptUtils/gptUtils.js';

const BIDDER_CODE = 'medianet';
const TRUSTEDSTACK_CODE = 'trustedstack';
const BID_URL = 'https://prebid.media.net/rtb/prebid';
const TRUSTEDSTACK_URL = 'https://prebid.trustedstack.com/rtb/trustedstack';
const PLAYER_URL = 'https://prebid.media.net/video/bundle.js';
const SLOT_VISIBILITY = {
  NOT_DETERMINED: 0,
  ABOVE_THE_FOLD: 1,
  BELOW_THE_FOLD: 2
};
const EVENTS = {
  TIMEOUT_EVENT_NAME: 'client_timeout',
  BID_WON_EVENT_NAME: 'client_bid_won'
};
const EVENT_PIXEL_URL = 'qsearch-a.akamaihd.net/log';
const OUTSTREAM = 'outstream';

// TODO: this should be picked from bidderRequest
let refererInfo = getRefererInfo();

let mnData = {};

window.mnet = window.mnet || {};
window.mnet.queue = window.mnet.queue || [];

mnData.urlData = {
  domain: refererInfo.domain,
  page: refererInfo.page,
  isTop: refererInfo.reachedTop
};

const aliases = [
  { code: TRUSTEDSTACK_CODE },
];

getGlobal().medianetGlobals = getGlobal().medianetGlobals || {};

function getTopWindowReferrer() {
  try {
    return window.top.document.referrer;
  } catch (e) {
    return document.referrer;
  }
}

function siteDetails(site, bidderRequest) {
  const urlData = bidderRequest.refererInfo;
  site = site || {};
  let siteData = {
    domain: site.domain || urlData.domain,
    page: site.page || urlData.page,
    ref: site.ref || getTopWindowReferrer(),
    topMostLocation: urlData.topmostLocation,
    isTop: site.isTop || urlData.reachedTop
  };

  return Object.assign(siteData, getPageMeta());
}

function getPageMeta() {
  if (mnData.pageMeta) {
    return mnData.pageMeta;
  }
  let canonicalUrl = getUrlFromSelector('link[rel="canonical"]', 'href');
  let ogUrl = getUrlFromSelector('meta[property="og:url"]', 'content');
  let twitterUrl = getUrlFromSelector('meta[name="twitter:url"]', 'content');

  mnData.pageMeta = Object.assign({},
    canonicalUrl && { 'canonical_url': canonicalUrl },
    ogUrl && { 'og_url': ogUrl },
    twitterUrl && { 'twitter_url': twitterUrl }
  );

  return mnData.pageMeta;
}

function getUrlFromSelector(selector, attribute) {
  let attr = getAttributeFromSelector(selector, attribute);
  return attr && getAbsoluteUrl(attr);
}

function getAttributeFromSelector(selector, attribute) {
  try {
    let doc = getWindowTop().document;
    let element = doc.querySelector(selector);
    if (element !== null && element[attribute]) {
      return element[attribute];
    }
  } catch (e) {}
}

function getAbsoluteUrl(url) {
  let aTag = getWindowTop().document.createElement('a');
  aTag.href = url;

  return aTag.href;
}

function filterUrlsByType(urls, type) {
  return urls.filter(url => url.type === type);
}

function transformSizes(sizes) {
  if (isArray(sizes) && sizes.length === 2 && !isArray(sizes[0])) {
    return [getSize(sizes)];
  }

  return sizes.map(size => getSize(size))
}

function getSize(size) {
  return {
    w: parseInt(size[0], 10),
    h: parseInt(size[1], 10)
  }
}

function getWindowSize() {
  return {
    w: window.screen.width || -1,
    h: window.screen.height || -1
  }
}

function getCoordinates(adUnitCode) {
  let element = document.getElementById(adUnitCode);
  if (!element && adUnitCode.indexOf('/') !== -1) {
    // now it means that adUnitCode is GAM AdUnitPath
    const {divId} = getGptSlotInfoForAdUnitCode(adUnitCode);
    if (isStr(divId)) {
      element = document.getElementById(divId);
    }
  }
  if (element && element.getBoundingClientRect) {
    const rect = element.getBoundingClientRect();
    let coordinates = {};
    coordinates.top_left = {
      y: rect.top,
      x: rect.left
    };
    coordinates.bottom_right = {
      y: rect.bottom,
      x: rect.right
    };
    return coordinates
  }
  return null;
}

function extParams(bidRequest, bidderRequests) {
  const params = deepAccess(bidRequest, 'params');
  const gdpr = deepAccess(bidderRequests, 'gdprConsent');
  const uspConsent = deepAccess(bidderRequests, 'uspConsent');
  const userId = deepAccess(bidRequest, 'userId');
  const sChain = deepAccess(bidRequest, 'schain') || {};
  const windowSize = spec.getWindowSize();
  const gdprApplies = !!(gdpr && gdpr.gdprApplies);
  const uspApplies = !!(uspConsent);
  const coppaApplies = !!(config.getConfig('coppa'));
  return Object.assign({},
    { customer_id: params.cid },
    { prebid_version: getGlobal().version },
    { gdpr_applies: gdprApplies },
    (gdprApplies) && { gdpr_consent_string: gdpr.consentString || '' },
    { usp_applies: uspApplies },
    uspApplies && { usp_consent_string: uspConsent || '' },
    {coppa_applies: coppaApplies},
    windowSize.w !== -1 && windowSize.h !== -1 && { screen: windowSize },
    userId && { user_id: userId },
    getGlobal().medianetGlobals.analyticsEnabled && { analytics: true },
    !isEmpty(sChain) && {schain: sChain}
  );
}

function slotParams(bidRequest) {
  // check with Media.net Account manager for  bid floor and crid parameters
  let params = {
    id: bidRequest.bidId,
    transactionId: bidRequest.ortb2Imp?.ext?.tid,
    ext: {
      dfp_id: bidRequest.adUnitCode,
      display_count: bidRequest.bidRequestsCount
    },
    all: bidRequest.params
  };

  if (bidRequest.ortb2Imp) {
    params.ortb2Imp = bidRequest.ortb2Imp;
  }

  let bannerSizes = deepAccess(bidRequest, 'mediaTypes.banner.sizes') || [];

  const videoInMediaType = deepAccess(bidRequest, 'mediaTypes.video') || {};
  const videoInParams = deepAccess(bidRequest, 'params.video') || {};
  const videoCombinedObj = Object.assign({}, videoInParams, videoInMediaType);

  if (!isEmpty(videoCombinedObj)) {
    params.video = videoCombinedObj;
  }

  if (bannerSizes.length > 0) {
    params.banner = transformSizes(bannerSizes);
  }
  if (bidRequest.nativeParams) {
    try {
      params.native = JSON.stringify(bidRequest.nativeParams);
    } catch (e) {
      logError((`${BIDDER_CODE} : Incorrect JSON : bidRequest.nativeParams`));
    }
  }

  if (bidRequest.params.crid) {
    params.tagid = bidRequest.params.crid.toString();
  }

  let bidFloor = parseFloat(bidRequest.params.bidfloor || bidRequest.params.bidFloor);
  if (bidFloor) {
    params.bidfloor = bidFloor;
  }
  const coordinates = getCoordinates(bidRequest.adUnitCode);
  if (coordinates && params.banner && params.banner.length !== 0) {
    let normCoordinates = normalizeCoordinates(coordinates);
    params.ext.coordinates = normCoordinates;
    params.ext.viewability = getSlotVisibility(coordinates.top_left, getMinSize(params.banner));
    if (getSlotVisibility(normCoordinates.top_left, getMinSize(params.banner)) > 0.5) {
      params.ext.visibility = SLOT_VISIBILITY.ABOVE_THE_FOLD;
    } else {
      params.ext.visibility = SLOT_VISIBILITY.BELOW_THE_FOLD;
    }
  } else {
    params.ext.visibility = SLOT_VISIBILITY.NOT_DETERMINED;
  }
  const floorInfo = getBidFloorByType(bidRequest);
  if (floorInfo && floorInfo.length > 0) {
    params.bidfloors = floorInfo;
  }

  return params;
}

function getBidFloorByType(bidRequest) {
  let floorInfo = [];
  if (typeof bidRequest.getFloor === 'function') {
    [BANNER, VIDEO, NATIVE].forEach(mediaType => {
      if (bidRequest.mediaTypes.hasOwnProperty(mediaType)) {
        if (mediaType == BANNER) {
          bidRequest.mediaTypes.banner.sizes.forEach(
            size => {
              setFloorInfo(bidRequest, mediaType, size, floorInfo)
            }
          )
        } else {
          setFloorInfo(bidRequest, mediaType, '*', floorInfo)
        }
      }
    });
  }
  return floorInfo;
}
function setFloorInfo(bidRequest, mediaType, size, floorInfo) {
  let floor = bidRequest.getFloor({currency: 'USD', mediaType: mediaType, size: size});
  if (size.length > 1) floor.size = size;
  floor.mediaType = mediaType;
  floorInfo.push(floor);
}
function getMinSize(sizes) {
  return sizes.reduce((min, size) => size.h * size.w < min.h * min.w ? size : min);
}

function getSlotVisibility(topLeft, size) {
  let maxArea = size.w * size.h;
  let windowSize = spec.getWindowSize();
  let bottomRight = {
    x: topLeft.x + size.w,
    y: topLeft.y + size.h
  };
  if (maxArea === 0 || windowSize.w === -1 || windowSize.h === -1) {
    return 0;
  }

  return getOverlapArea(topLeft, bottomRight, {x: 0, y: 0}, {x: windowSize.w, y: windowSize.h}) / maxArea;
}

// find the overlapping area between two rectangles
function getOverlapArea(topLeft1, bottomRight1, topLeft2, bottomRight2) {
  // If no overlap, return 0
  if ((topLeft1.x > bottomRight2.x || bottomRight1.x < topLeft2.x) || (topLeft1.y > bottomRight2.y || bottomRight1.y < topLeft2.y)) {
    return 0;
  }
  // return overlapping area : [ min of rightmost/bottommost co-ordinates ] - [ max of leftmost/topmost co-ordinates ]
  return ((Math.min(bottomRight1.x, bottomRight2.x) - Math.max(topLeft1.x, topLeft2.x)) * (Math.min(bottomRight1.y, bottomRight2.y) - Math.max(topLeft1.y, topLeft2.y)));
}

function normalizeCoordinates(coordinates) {
  return {
    top_left: {
      x: coordinates.top_left.x + window.pageXOffset,
      y: coordinates.top_left.y + window.pageYOffset,
    },
    bottom_right: {
      x: coordinates.bottom_right.x + window.pageXOffset,
      y: coordinates.bottom_right.y + window.pageYOffset,
    }
  }
}

function getBidderURL(bidderCode, cid) {
  const url = (bidderCode === TRUSTEDSTACK_CODE) ? TRUSTEDSTACK_URL : BID_URL;
  return url + '?cid=' + encodeURIComponent(cid);
}

function generatePayload(bidRequests, bidderRequests) {
  return {
    site: siteDetails(bidRequests[0].params.site, bidderRequests),
    ext: extParams(bidRequests[0], bidderRequests),
    // TODO: fix auctionId leak: https://github.com/prebid/Prebid.js/issues/9781
    id: bidRequests[0].auctionId,
    imp: bidRequests.map(request => slotParams(request)),
    ortb2: bidderRequests.ortb2,
    tmax: bidderRequests.timeout
  }
}

function isValidBid(bid) {
  return bid.no_bid === false && parseFloat(bid.cpm) > 0.0;
}

function fetchCookieSyncUrls(response) {
  if (!isEmpty(response) && response[0].body &&
    response[0].body.ext && isArray(response[0].body.ext.csUrl)) {
    return response[0].body.ext.csUrl;
  }

  return [];
}

function getLoggingData(event, data) {
  data = (isArray(data) && data) || [];

  let params = {};
  params.logid = 'kfk';
  params.evtid = 'projectevents';
  params.project = 'prebid';
  params.acid = deepAccess(data, '0.auctionId') || '';
  params.cid = getGlobal().medianetGlobals.cid || '';
  params.crid = data.map((adunit) => deepAccess(adunit, 'params.0.crid') || adunit.adUnitCode).join('|');
  params.adunit_count = data.length || 0;
  params.dn = mnData.urlData.domain || '';
  params.requrl = mnData.urlData.page || '';
  params.istop = mnData.urlData.isTop || '';
  params.event = event.name || '';
  params.value = event.value || '';
  params.rd = event.related_data || '';

  return params;
}

function logEvent (event, data) {
  let getParams = {
    protocol: 'https',
    hostname: EVENT_PIXEL_URL,
    search: getLoggingData(event, data)
  };
  triggerPixel(buildUrl(getParams));
}

function clearMnData() {
  mnData = {};
}

function addRenderer(bid) {
  const videoContext = deepAccess(bid, 'context') || '';
  const vastTimeout = deepAccess(bid, 'vto');
  /* Adding renderer only when the context is Outstream
     and the provider has responded with a renderer.
   */
  if (videoContext == OUTSTREAM && vastTimeout) {
    bid.renderer = newVideoRenderer(bid);
  }
}

function newVideoRenderer(bid) {
  const renderer = Renderer.install({
    url: PLAYER_URL,
  });
  renderer.setRender(function (bid) {
    window.mnet.queue.push(function () {
      const obj = {
        width: bid.width,
        height: bid.height,
        vastTimeout: bid.vto,
        maxAllowedVastTagRedirects: bid.mavtr,
        allowVpaid: bid.avp,
        autoPlay: bid.ap,
        preload: bid.pl,
        mute: bid.mt
      }
      const adUnitCode = bid.dfp_id;
      const divId = getGptSlotInfoForAdUnitCode(adUnitCode).divId || adUnitCode;
      window.mnet.mediaNetoutstreamPlayer(bid, divId, obj);
    });
  });
  return renderer;
}
export const spec = {

  code: BIDDER_CODE,
  gvlid: 142,
  aliases,
  supportedMediaTypes: [BANNER, NATIVE, VIDEO],

  /**
   * Determines whether or not the given bid request is valid.
   *
   * @param {object} bid The bid to validate.
   * @return boolean True if this is a valid bid (if cid is present), and false otherwise.
   */
  isBidRequestValid: function(bid) {
    if (!bid.params) {
      logError(`${BIDDER_CODE} : Missing bid parameters`);
      return false;
    }

    if (!bid.params.cid || !isStr(bid.params.cid) || isEmptyStr(bid.params.cid)) {
      logError(`${BIDDER_CODE} : cid should be a string`);
      return false;
    }

    Object.assign(getGlobal().medianetGlobals, !getGlobal().medianetGlobals.cid && {cid: bid.params.cid});

    return true;
  },

  /**
   * Make a server request from the list of BidRequests.
   *
   * @param {BidRequest[]} bidRequests A non-empty list of bid requests which should be sent to the Server.
   * @param {BidderRequests} bidderRequests
   * @return ServerRequest Info describing the request to the server.
   */
  buildRequests: function(bidRequests, bidderRequests) {
    // convert Native ORTB definition to old-style prebid native definition
    bidRequests = convertOrtbRequestToProprietaryNative(bidRequests);

    let payload = generatePayload(bidRequests, bidderRequests);
    return {
      method: 'POST',
      url: getBidderURL(bidderRequests.bidderCode, payload.ext.customer_id),
      data: JSON.stringify(payload)
    };
  },

  /**
   * Unpack the response from the server into a list of bids.
   *
   * @param {*} serverResponse A successful response from the server.
   * @return {Bid[]} An array of bids which were nested inside the server.
   */
  interpretResponse: function(serverResponse, request) {
    let validBids = [];

    if (!serverResponse || !serverResponse.body) {
      logInfo(`${BIDDER_CODE} : response is empty`);
      return validBids;
    }

    let bids = serverResponse.body.bidList;
    if (!isArray(bids) || bids.length === 0) {
      logInfo(`${BIDDER_CODE} : no bids`);
      return validBids;
    }
    validBids = bids.filter(bid => isValidBid(bid));

    validBids.forEach(addRenderer);

    return validBids;
  },
  getUserSyncs: function(syncOptions, serverResponses) {
    let cookieSyncUrls = fetchCookieSyncUrls(serverResponses);

    if (syncOptions.iframeEnabled) {
      return filterUrlsByType(cookieSyncUrls, 'iframe');
    }

    if (syncOptions.pixelEnabled) {
      return filterUrlsByType(cookieSyncUrls, 'image');
    }
  },

  /**
   * @param {TimedOutBid} timeoutData
   */
  onTimeout: (timeoutData) => {
    try {
      let eventData = {
        name: EVENTS.TIMEOUT_EVENT_NAME,
        value: timeoutData.length,
        related_data: timeoutData[0].timeout || config.getConfig('bidderTimeout')
      };
      logEvent(eventData, timeoutData);
    } catch (e) {}
  },

  /**
   * @param {TimedOutBid} timeoutData
   */
  onBidWon: (bid) => {
    try {
      let eventData = {
        name: EVENTS.BID_WON_EVENT_NAME,
        value: bid.cpm
      };
      logEvent(eventData, [bid]);
    } catch (e) {}
  },

  clearMnData,

  getWindowSize,
};
registerBidder(spec);
