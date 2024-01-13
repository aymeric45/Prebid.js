import {ortbConverter} from 'libraries/ortbConverter/converter.js';
import {registerBidder} from '../src/adapters/bidderFactory.js';
import {config} from '../src/config.js';
import {getUniqueIdentifierStr,logInfo} from '../src/utils.js';

const bidderCode = 'lucead';
const isDevEnv = location.hostname.includes('ngrok');
//const ENABLE_SRA = false;
let loadCompanion = true;
const baseUrl = isDevEnv ? `https://${location.hostname}` : 'https://ayads.io';
const endpointUrl = baseUrl + '/go';
const defaultCurrency = 'EUR';
const defaultTtl = 300;

export const state = {
  timeout: config.getConfig('bidderTimeout'),
};

function isBidRequestValid() {
  return true
}

export function log(msg, obj) {
  logInfo('Lucead - ' + msg, obj);
}

function buildRequests(validBidRequests, bidderRequest) {
  loadCompanion = typeof validBidRequests[0]?.params?.loadCompanion !== 'undefined' ? validBidRequests[0].params.loadCompanion : loadCompanion;

  log('buildRequests', {
    validBidRequests,
    bidderRequest,
    loadCompanion,
  });

  const companionData = {
    base_url: baseUrl,
    endpoint_url: endpointUrl,
    request_id: bidderRequest.bidderRequestId,
    validBidRequests,
    bidderRequest,
    getUniqueIdentifierStr,
    ortbConverter,
  };

  if (loadCompanion) {
    const script = document.createElement('script');
    script.src = `${baseUrl}/dist/prebid-companion.js`;
    //script.type = 'module';
    script.onload = () => window.ayads_prebid(companionData);
    document.body.appendChild(script);
  } else {
    if (window.ayads_prebid) {
      window.ayads_prebid(companionData);
    } else {
      window.ayads_prebid_data = companionData;
    }
  }

  /*report('placement',{
    placement_ids:validBidRequests.map(bid=>bid?.params?.placementId),
  });*/

  return validBidRequests.map(bidRequest => ({
    method: 'POST',
    url: endpointUrl + '/prebid/sub',
    data: JSON.stringify({
      request_id: bidderRequest.bidderRequestId,
      domain: location.hostname,
      bid_id: bidRequest.bidId,
      sizes: bidRequest.sizes,
      media_types: bidRequest.mediaTypes,
      fledge_enabled: bidderRequest.fledgeEnabled,
      enable_contextual: bidRequest?.params?.enableContextual !== false,
      enable_pa: bidRequest?.params?.enablePA !== false,
      params: bidRequest.params,
    }),
    options: {
      contentType: 'text/plain',
      withCredentials: false
    },
  }));
}

function interpretResponse(serverResponse, bidRequest) {
  // @see required fields https://docs.prebid.org/dev-docs/bidder-adaptor.html
  const response = serverResponse.body;
  const bidRequestData = JSON.parse(bidRequest.data);
  log('interpretResponse', {serverResponse, bidRequest, bidRequestData});

  const bids = bidRequestData.enable_contextual ? [{
    requestId: response.bid_id || '1', //bid request id, the bid id
    cpm: response.cpm || 0,
    width: (response.size && response?.size?.width) || 300,
    height: (response.size && response?.size?.height) || 250,
    currency: response.currency || defaultCurrency,
    ttl: response.ttl || defaultTtl,
    creativeId: response.ad_id || '0',
    netRevenue: response.netRevenue || true,
    ad: response.ad || '',
    meta: {
      advertiserDomains: response.advertiserDomains || [],
    },
  }]: null;

  if(!bidRequestData.enable_pa)
    return bids;

  const fledgeAuctionConfig = {
    seller: baseUrl,
    decisionLogicUrl: `${baseUrl}/js/ssp.js`,
    interestGroupBuyers: [baseUrl],
    perBuyerSignals: {},
    auctionSignals: {
      size: {width: bidRequestData.sizes[0][0] || 300, height: bidRequestData.sizes[0][1] || 250},
    },
  };

  const fledgeAuctionConfigs = bidRequestData.enable_pa ? [{bidId: response.bid_id, config: fledgeAuctionConfig}]: null;

  return {bids,fledgeAuctionConfigs};
}

function report(type='impression',data={}) {
  // noinspection JSCheckFunctionSignatures
  fetch(`${endpointUrl}/report/${type}`, {
    body:JSON.stringify(data),
    method:'POST',
    contentType:'text/plain'
  }).catch(console.error);
}

function onBidWon(bid) {
  log('Bid won', bid);

  report(`impression`, {
    bid_id:bid.bidId,
    ad_id:bid.creativeId,
    placement_id:bid?.params[0]?.placementId,
    spent:bid.cpm,
    currency:bid.currency,
  });
}

function onTimeout(timeoutData) {
  log('Timeout from adapter', timeoutData);
}

export const spec = {
  code: bidderCode,
  // gvlid: BIDDER_GVLID,
  aliases: [],
  isBidRequestValid,
  buildRequests,
  interpretResponse,
  onBidWon,
  onTimeout,
};

// noinspection JSCheckFunctionSignatures
registerBidder(spec);
