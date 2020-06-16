import { ApiPromise } from "@polkadot/api";
import { hexToU8a } from "@polkadot/util";
import * as fs from "fs";

import { initApi, sleep } from "../../../helpers";
import { Block } from "./types";
import { IgnoreMethods } from "./consts";
import { initializeSigner } from "./helpers";
import logger from "../../../logger";

const sendHandler = (result: any, unsub: any, nonceStr: string = "", pastHash?: any) => {
  const { status } = result;

  console.log(`${nonceStr} Current status is ${status.type}`);
  if (status.isFinalized) {
    console.log(`${nonceStr} Included in block hash ${status.asFinalized}`);
    unsub();
  }
}

type CallDetails = {
  args: any;
  callIndex: string;
};

/**
 * Recursive function to create the correct calls.
 * @param api 
 * @param extrinsic 
 */
const createCall = (api: ApiPromise, details: CallDetails): any => {
  const { args, callIndex } = details;
  const { method, section } = api.registry.findMetaCall(
    hexToU8a(callIndex),
  );

  switch (method) {
    case "killStorage":
      return api.tx[section][method](args.keys);
    case "setStorage":
      return api.tx[section][method](args.items);
    case "bond":
      return api.tx[section][method](args.controller, args.value, args.payee);
    case "nominate":
      return api.tx[section][method](args.targets);
    case "setController":
      return api.tx[section][method](args.controller);
    case "setKeys":
      return api.tx[section][method](args.keys, args.proof);
    case "validate":
      return api.tx[section][method](args.prefs);
    case "forceTransfer":
      return api.tx[section][method](args.source, args.dest, args.value);
    case "transfer":
      return api.tx[section][method](args.dest, args.value);
    case "proxy": {
      const call: any = createCall(api, args.call);
      return api.tx[section][method](args.real, args.force_proxy_type, call);
    }
    case "sudo": {
      return api.tx[section][method](createCall(api, args.call))
    }
    case "batch": {
      const calls = args.calls.map((call: CallDetails) => createCall(api, call));
      return api.tx[section][method](calls);
    }
    case "anonymous": {
      return api.tx[section][method](args.proxy_type, args.index);
    }
    default: {
      throw new Error(`############### Method missing to check ############# : ${section} ${method}`);
    }
  }
}

type Options = {
  dbPath: string;
  dry: boolean;
  ensureComplete: boolean;
  trickle: boolean;
  suri: string;
  wsEndpoint: string;
}

const migrate = async (opts: Options) => {
  const { dbPath, dry, ensureComplete, trickle, suri, wsEndpoint } = opts;

  const api = await initApi(wsEndpoint);

  // Get the database contents, sort it by block number and filter the transactions
  // we don't want.
  const blocks: Block[] = fs.readFileSync(dbPath, { encoding: "utf-8" })
    .split("\n")                    // Split by newlines
    .filter(line => line !== "")    // filter empty lines
    .map(line => JSON.parse(line))  // make 'em JSON
    .sort((a: any, b: any) => {     // sort them in ascending
      return a.number - b.number;
    });

  if (ensureComplete) {
    let count = 1;
    while (count < blocks.length) {
      if (Number(blocks[count-1].number) !== count) {
        throw new Error(`Missing a block: ${count} GOT: ${blocks[count].number}`);
      }
      count++;
    }
  }
    
  const mySigner = initializeSigner(suri);
  console.log(`Signer address: ${mySigner.address}`);

  const sudo = await api.query.sudo.key();
  if (!dry && (mySigner.address !== sudo.toString())) {
    throw new Error(
`NOT SUDO SIGNER.. GOT ${mySigner.address} EXPECTED ${sudo.toString()}`
    );
  }

  const { nonce } = await api.query.system.account(mySigner.address);
  const startingNonce: number = nonce.toNumber();

  // Now cycle through blocks ascending and inject new transactions.
  let index = 0;
  let wait = false;
  for (const block of blocks) {
    const { extrinsics, number } = block;
    console.log(`Checking block ${number}`);

    for (const extrinsic of extrinsics) {
      const { args, hash, method, signature } = extrinsic;
      
      if (IgnoreMethods.includes(method)) {
        console.log(`Skipping ignore method: ${method}`)
        continue;
      }

      const [module, txType] = method.split('.');

      if (txType === "sudoUncheckedWeight" && args[0].args.code) {
        console.log(`Skipping runtime upgrade.`);
        continue;
      }

      if (txType === "claimAttest") {
        // The only unsigned transaction.
        try {
          if (!dry) {
            const unsub = await api.tx[module][txType](...args).send((result) => {
              sendHandler(result, unsub);
            });
            if (trickle) wait = true;
          } else {
            console.log("Stubbing unsigned transaction.");
          }
        } catch (err) {
          throw new Error(`Failed submitting transfaction: ${err}`);
        } 
      } else {
        const { signer } = signature;
        const currentNonce = Number(startingNonce) + index;
        const nonceStr = `Nonce: ${currentNonce} |`;
        const logStr = `${nonceStr} Migrating transaction ${module}.${txType} originally sent by ${signer}.`;
        
        /// Construct the proposal.
        let proposal = null;
        switch (txType) {
          case "batch": {
            const calls = args[0].map((details: CallDetails) => {
              return createCall(api, details);
            });
            proposal = api.tx[module][txType](calls);
            break;
          }
          case "sudo": {
            proposal = api.tx[module][txType](createCall(api, args[0])); 
            break;
          }
          case "sudoUncheckedWeight": {
            proposal = api.tx[module][txType](createCall(api, args[0]), args[1]);
            break;
          }
          case "asMulti": {
            proposal = api.tx[module][txType](args[0], args[1], args[2], createCall(api, args[3]));
            break;
          }
          default:
            proposal = api.tx[module][txType](...args);
        }

        console.log(logStr);

        if (!dry) {
          const unsub: any = await api.tx.sudo.sudoAs(signer, proposal)
            .signAndSend(
              mySigner,
              (result) => sendHandler(result, unsub, nonceStr, hash)
            );

          if (trickle) wait = true;
        }
        index++;
      }
    }

    if (wait) {
      await sleep(6000); // (block time)
    }
  }
}

export default migrate;
