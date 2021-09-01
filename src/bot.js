require("dotenv").config();

const dayjs = require("dayjs");
dayjs.locale("th");

const { default: BigNumber } = require("bignumber.js");

const { 
  SENDER_PRIVATE_KEY, 
  BSC_WSS_RPC, 
  CHANNEL_ID, 
  TWX_DOPX_LP_ADDRESS, 
  TWX_WBNB_LP_ADDRESS,
  TWX_KUSD_LP_ADDRESS,
  TWX_WBNB_PC_LP_ADDRESS,
  REDIS_URI, 
  BACKOFF_DELAY, 
  ATTEMPTS 
} = process.env;

const options = {
  // Enable auto reconnection
  reconnect: {
    auto: true,
    delay: 5000, // ms
    maxAttempts: 5,
    onTimeout: false,
  },
};

const bluebird = require("bluebird");
const redis = require("redis");
bluebird.promisifyAll(redis.RedisClient.prototype);
const client = redis.createClient();

const Web3 = require("web3");
const wss = new Web3.providers.WebsocketProvider(BSC_WSS_RPC, options);
const web3 = new Web3(wss);

web3.eth.accounts.wallet.add(SENDER_PRIVATE_KEY);
const sender = web3.eth.accounts.wallet[0];

const { fromWei, toWei } = require("web3-utils");

const Queue = require("bull");
const sendMessageQueue = new Queue("sendMessage", REDIS_URI, {
  defaultJobOptions: {
    attempts: ATTEMPTS,
    removeOnComplete: false,
    backoff: { type: "exponential", delay: BACKOFF_DELAY },
  },
  settings: {
    maxStalledCount: 0,
    lockDuration: 60000,
  },
  limiter: {
    // Limit queue to max 1 jobs per 2 seconds.
    max: 1000,
    duration: 2000,
  },
});
sendMessageQueue.process("sendMessage", __dirname + "/processor.js");

const { abi: pairABI } = require("./Pair.json");

const pair1 = new web3.eth.Contract(pairABI, TWX_DOPX_LP_ADDRESS);
const pair2 = new web3.eth.Contract(pairABI, TWX_WBNB_LP_ADDRESS);
const pair3 = new web3.eth.Contract(pairABI, TWX_KUSD_LP_ADDRESS);
const pair4 = new web3.eth.Contract(pairABI, TWX_WBNB_PC_LP_ADDRESS);

const buy = async (amountIn, twxAmount, symbol, dex, txHash, timestamp) => {
  const price = await client.getAsync(symbol.toLowerCase() + "-price");
  const tradeValue = BigNumber(amountIn).times(price);
  const twxValue = tradeValue.div(twxAmount);
  const twxPrice = BigNumber(amountIn).div(twxAmount);

  const date = new Date();
  date.setTime(parseInt(timestamp) * 1000);
  const day = dayjs(date);

  const text = `
🟩 BUY>TWX-${symbol.toUpperCase()} (${dex})

         ${parseFloat(fromWei(amountIn)).toLocaleString()} ${symbol.toUpperCase()}
              👇 ($${parseFloat(tradeValue.div(toWei("1")).toFixed()).toLocaleString()})
         ${parseFloat(fromWei(twxAmount)).toLocaleString()} TWX

${symbol.toUpperCase()} price: $${parseFloat(price).toLocaleString()}
TWX swap price: <b>$${parseFloat(twxValue.toString()).toLocaleString()}</b> (${parseFloat(twxPrice.toString()).toLocaleString(undefined, {'maximumFractionDigits':5})} ${symbol.toUpperCase()})
🔎 <a href="https://bscscan.com/tx/${txHash}">View</a> | 🕒 ${day.format("DD/MM/YYYY HH:mm:ss")}
`;
  return text;  
};

const sell = async (twxAmount, amountOut, symbol, dex, txHash, timestamp) => {
  const price = await client.getAsync(symbol.toLowerCase() + "-price");
  const tradeValue = BigNumber(amountOut).times(price);
  const twxValue = tradeValue.div(twxAmount);
  const twxPrice = BigNumber(amountOut).div(twxAmount);

  const date = new Date();
  date.setTime(parseInt(timestamp) * 1000);
  const day = dayjs(date);

  const text = `
🟥 SELL>TWX-${symbol.toUpperCase()} (${dex})

         ${parseFloat(fromWei(twxAmount)).toLocaleString()} TWX
              👇 ($${parseFloat(tradeValue.div(toWei("1")).toFixed()).toLocaleString()})
         ${parseFloat(fromWei(amountOut)).toLocaleString()} ${symbol.toUpperCase()}

${symbol.toUpperCase()} price: $${parseFloat(price).toLocaleString()}
TWX swap price: <b>$${parseFloat(twxValue.toString()).toLocaleString()}</b> (${parseFloat(twxPrice.toString()).toLocaleString(undefined, {'maximumFractionDigits':5})} ${symbol.toUpperCase()})
🔎 <a href="https://bscscan.com/tx/${txHash}">View</a> | 🕒 ${day.format("DD/MM/YYYY HH:mm:ss")}
`;
  return text;  
};

const watch = async (pair, token, dex) => {
  pair.events
    .Swap({})
    .on("data", async (event) => {
      const { blockNumber, transactionHash, returnValues } = event;
      const { amount0In, amount1In, amount0Out, amount1Out } = returnValues;
      const block = await web3.eth.getBlock(blockNumber);
      let text;
      if (amount0In == "0") {
        //buy twx
        text = await buy(
          amount1In,
          amount0Out,
          token,
          dex,
          transactionHash,
          block.timestamp
        );
      } else {
        // sell twx
        text = await sell(
          amount0In,
          amount1Out,
          token,
          dex,
          transactionHash,
          block.timestamp
        );
      }
      sendMessageQueue.add("sendMessage", {message: text, chatId:CHANNEL_ID});
    })
    .on("error", console.error);
};


const main = async () => {
  web3.eth
    .subscribe("newBlockHeaders", async (error, result) => {
      if (!error) {
        const block = await web3.eth.getBlock("latest");
        console.log(block.number);
        return;
      }
      console.error(error);
    })
    .on("error", console.error);

  await watch(pair1, "dopx", "Twindex");
  await watch(pair2, "bnb", "Twindex");
  await watch(pair3, "kusd", "Twindex");
  await watch(pair4, "bnb", "Pancake");
};

main()