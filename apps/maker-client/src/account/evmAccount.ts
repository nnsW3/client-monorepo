import {
  ethers,
  Interface,
  isError,
  keccak256,
  type Wallet,
} from "ethers6";
import { abis, NonceManager } from "@orbiter-finance/utils";
import {
  TransactionRequest,
  TransactionResponse,
  TransferResponse,
  Context,
} from "./IAccount";
import OrbiterAccount from "./orbiterAccount";
import BigNumber from "bignumber.js";
import {
  TransactionFailedError,
  TransactionSendBeforeError,
} from "./IAccount.interface";
import { provider, JSONStringify, timeoutPromise } from "@orbiter-finance/utils";
export default class EVMAccount extends OrbiterAccount {
  protected wallet: Wallet;
  public nonceManager: NonceManager;
  #provider: provider.Orbiter6Provider;
  public address: string;
  constructor(protected chainId: string, protected readonly ctx: Context) {
    super(chainId, ctx);
  }
  getProvider() {
    const chainConfig = this.chainConfig;
    const rpc = chainConfig.rpc[0];
    if (!this.#provider) {
      this.#provider = new provider.Orbiter6Provider(rpc);
    }
    if (this.#provider && this.#provider.getUrl() != rpc) {
      this.logger.debug(
        `rpc url changes new ${rpc} old ${this.#provider.getUrl()}`,
      );
      this.#provider = new provider.Orbiter6Provider(rpc);
    }
    return this.#provider;
  }
  async connect(privateKey: string) {
    const provider = this.getProvider();
    this.wallet = new ethers.Wallet(privateKey).connect(provider);
    this.address = this.wallet.address;
    if (!this.nonceManager) {
      this.nonceManager = new NonceManager(this.wallet.address, async () => {
        const nonce = await this.wallet.getNonce("pending");
        return Number(nonce);
      });
      await this.nonceManager.forceRefreshNonce();
    }
    return this;
  }

  async transferToken(
    token: string,
    to: string,
    value: bigint,
    transactionRequest: TransactionRequest = {}
  ): Promise<TransferResponse> {
    try {
      const balance = await this.getTokenBalance(token);
      if (balance < value) {
        throw new TransactionSendBeforeError(
          `The sender ${token} has insufficient balance`
        );
      }
      const ifa = new Interface(abis.ERC20Abi);
      const data = ifa.encodeFunctionData("transfer", [to, value]);
      transactionRequest.data = data;
      transactionRequest.to = token;
      transactionRequest.value = 0n;
      transactionRequest.from = this.wallet.address;
      // get erc20 getLimit
      await timeoutPromise(() => this.getGasPrice(transactionRequest), 1000 * 30);
    } catch (error) {
      throw new TransactionSendBeforeError(error.message);
    }
    const tx = await this.sendTransaction(token, transactionRequest);
    return {
      hash: tx.hash,
      nonce: tx.nonce,
      from: tx.from,
      to,
      token,
      value,
      _response: tx,
    };
  }

  async getGasPrice(transactionRequest: TransactionRequest): Promise<TransactionRequest> {
    const chainConfig = this.chainConfig;
    const chainCustomConfig = await this.ctx.envConfigService.getAsync(chainConfig.chainId) || {};
    const provider = this.getProvider();
    if (!transactionRequest.gasLimit) {
      const gasLimit = await provider.estimateGas({
        from: transactionRequest.from,
        to: transactionRequest.to,
        data: transactionRequest.data,
        value: transactionRequest.value,
      });
      transactionRequest.gasLimit = gasLimit;

      if (!transactionRequest.gasLimit) {
        throw new Error('gasLimit Fee fail')
      }
    }
    let isEIP1559 = false;
    const feeData = await provider.getFeeData();
    if (transactionRequest.type === 0) {
      isEIP1559 = false;
    } else if (transactionRequest.type === 2) {
      isEIP1559 = true;
    } else {
      if (feeData.maxFeePerGas && feeData.maxPriorityFeePerGas) {
        isEIP1559 = true;
      }
    }
    if (isEIP1559) {
      let maxFeePerGas = chainCustomConfig.MinFeePerGas || 0;
      let maxPriorityFeePerGas = chainCustomConfig.MinPriorityFeePerGas || 0;
      if (
        !transactionRequest.maxFeePerGas ||
        !transactionRequest.maxPriorityFeePerGas
      ) {
        if (feeData.maxFeePerGas && feeData.maxPriorityFeePerGas) {
          maxFeePerGas = Math.max(Number(feeData.maxFeePerGas), maxFeePerGas);
          maxPriorityFeePerGas = Math.max(Number(feeData.maxPriorityFeePerGas), maxPriorityFeePerGas);
        }
        transactionRequest.type = 2;
        transactionRequest.maxFeePerGas = maxFeePerGas;
        transactionRequest.maxPriorityFeePerGas = maxPriorityFeePerGas;
      }
      if (!transactionRequest.maxFeePerGas || !transactionRequest.maxPriorityFeePerGas) {
        throw new Error('EIP1559 Fee fail')
      }
      // delete transactionRequest.gasPrice;
    } else {
      let maxFeePerGas = transactionRequest.gasPrice || 0n;
      if (!maxFeePerGas || +maxFeePerGas.toString() <= 0) {
        maxFeePerGas = feeData.gasPrice;
      }
      transactionRequest.type = 0;
      transactionRequest.gasPrice = Math.max(
        chainCustomConfig.MinFeePerGas,
        +maxFeePerGas.toString()
      );
      if (!transactionRequest.gasPrice) {
        throw new Error('gasPrice Fee fail')
      }
    }
    return transactionRequest;
  }

  async transfer(
    to: string,
    value: bigint,
    transactionRequest: TransactionRequest = {}
  ): Promise<TransferResponse> {
    try {
      const balance = await this.getBalance();
      if (balance < value) {
        throw new TransactionSendBeforeError(
          "The sender has insufficient balance"
        );
      }
      transactionRequest.to = to;
      transactionRequest.value = value as any;
      transactionRequest.from = this.wallet.address;
      // get getLimit
      await timeoutPromise(() => this.getGasPrice(transactionRequest), 1000 * 30);
    } catch (error) {
      throw new TransactionSendBeforeError(error.message);
    }
    const response = await this.sendTransaction(to, transactionRequest);
    return response;
  }

  async transfers(
    tos: string[],
    values: bigint[],
    transactionRequest: TransactionRequest = {}
  ) {
    let router;
    const chainConfig = this.chainConfig;
    try {
      if (tos.length !== values.length) {
        throw new TransactionSendBeforeError(
          "to and values are inconsistent in length"
        );
      }
      router = Object.keys(chainConfig.contract || {}).find(
        (addr) => chainConfig.contract[addr] === "OrbiterXRouter"
      );
      if (!router) {
        throw new TransactionSendBeforeError(
          "transferTokens router not config"
        );
      }
      const totalValue = values.reduce(
        (accumulator, currentValue) => accumulator + currentValue,
        0n
      );
      //
      const balance = await this.getBalance();
      if (balance < totalValue) {
        throw new TransactionSendBeforeError(
          "The sender has insufficient balance"
        );
      }
      if (!abis.OrbiterRouterV3) {
        throw new TransactionSendBeforeError("OrbiterXRouter ABI Not Found");
      }
      const ifa = new Interface(abis.OrbiterRouterV3);
      transactionRequest.value = totalValue;
      transactionRequest.to = router;
      transactionRequest.data = ifa.encodeFunctionData("transfers", [
        tos,
        values,
      ]);
      await timeoutPromise(() => this.getGasPrice(transactionRequest), 1000 * 30);
    } catch (error) {
      throw new TransactionSendBeforeError(error.message);
    }
    const response = await this.sendTransaction(router, transactionRequest);
    return response;
  }

  public async transferTokens(
    token: string,
    tos: string[],
    values: bigint[],
    transactionRequest: TransactionRequest = {}
  ): Promise<TransferResponse | undefined> {
    let router;
    const chainConfig = this.chainConfig;
    try {
      if (tos.length !== values.length) {
        throw new TransactionSendBeforeError(
          "to and values are inconsistent in length"
        );
      }
      router = Object.keys(chainConfig.contract || {}).find(
        (addr) => chainConfig.contract[addr] === "OrbiterXRouter"
      );
      if (!router) {
        throw new TransactionSendBeforeError(
          "transferTokens router not config"
        );
      }
      const totalValue = values.reduce(
        (accumulator, currentValue) => accumulator + currentValue,
        0n
      );
      const balance = await this.getTokenBalance(token);
      if (balance < totalValue) {
        throw new TransactionSendBeforeError(
          `The sender ${token} has insufficient balance`
        );
      }
      if (!abis.OrbiterRouterV3) {
        throw new TransactionSendBeforeError("OrbiterXRouter ABI Not Found");
      }
      const ifa = new Interface(abis.OrbiterRouterV3);
      const data = ifa.encodeFunctionData("transferTokens", [
        token,
        tos,
        values,
      ]);
      transactionRequest.data = data;
      transactionRequest.to = router;
      await timeoutPromise(() => this.getGasPrice(transactionRequest), 1000 * 30);
    } catch (error) {
      throw new TransactionSendBeforeError(error.message);
    }
    const response = await this.sendTransaction(router, transactionRequest);
    return response;
  }

  async waitForTransactionConfirmation(transactionHash) {
    const provider = this.getProvider();
    const receipt = await provider.waitForTransaction(transactionHash);
    return receipt;
  }

  async sendTransaction(
    to: string,
    transactionRequest: TransactionRequest = {}
  ): Promise<TransactionResponse> {
    const serialIds =
      typeof transactionRequest.serialId === "string"
        ? [transactionRequest.serialId]
        : transactionRequest.serialId;
    this.logger.debug(`sendTransaction serialIds: ${JSONStringify(serialIds)}`)
    const chainConfig = this.chainConfig;
    const provider = this.getProvider();
    const chainId: number | undefined = Number(
      transactionRequest.chainId || chainConfig.chainId
    );

    const tx: TransactionRequest = {
      chainId,
      ...transactionRequest,
      from: this.wallet.address,
      to,
    };
    const { nonce, submit, rollback } = await this.nonceManager.getNextNonce();
    let txHash;
    try {
      tx.nonce = nonce;
      if (tx.value) {
        tx.value = new BigNumber(String(tx.value)).toFixed(0);
      }
      this.logger.debug(
        `${chainConfig.name} sendTransaction:${JSONStringify(tx)}`
      );
      const signedTx = await this.wallet.signTransaction(tx);
      txHash = keccak256(signedTx);
      const response = await provider.broadcastTransaction(signedTx);
      this.logger.debug(
        `${chainConfig.name} sendTransaction txHash:${txHash}`
      );
      await this.store.saveSerialRelTxHash(serialIds, txHash);
      submit();
      return response;
    } catch (error) {
      this.logger.error(
        `broadcastTransaction tx error:${txHash} - ${error.message}`,
        error
      );
      // rollback()
      if (isError(error, "NONCE_EXPIRED")) {
        throw new TransactionSendBeforeError(error.message);
      }
      throw new TransactionFailedError(error.message);
    }
  }

  public async approve(
    token: string,
    spender: string,
    value: string | BigNumber
  ) {
    const provider = this.getProvider();
    const erc20 = new ethers.Contract(token, abis.ERC20Abi, provider).connect(
      this.wallet
    );
    return await erc20["approve"](spender, value);
  }

  public async allowance(token: string, spender: string) {
    const provider = this.getProvider();
    const erc20 = new ethers.Contract(token, abis.ERC20Abi, provider).connect(
      this.wallet
    );
    return await erc20["allowance"](this.wallet.address, spender);
  }

  public async getBalance(address?: string, token?: string): Promise<bigint> {
    const chainConfig = this.chainConfig;
    const provider = this.getProvider();
    if (token && token != chainConfig.nativeCurrency.address) {
      // is native
      // const chainId = await this.wallet.getChainId();
      // const issMainToken = await chains.inValidMainToken(String(chainId), token);
      return await this.getTokenBalance(token, address);
    } else {
      return await provider.getBalance(address || this.wallet.address);
    }
  }

  public async getTokenBalance(
    token: string,
    address?: string
  ): Promise<bigint> {
    const provider = this.getProvider();
    const erc20 = new ethers.Contract(token, abis.ERC20Abi, provider);
    return await erc20.balanceOf(address || this.wallet.address);
  }
}
