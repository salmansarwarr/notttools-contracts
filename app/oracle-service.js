import {
    Connection,
    PublicKey,
    Transaction,
    sendAndConfirmTransaction,
    Keypair,
    clusterApiUrl,
} from "@solana/web3.js";
import {
    TOKEN_2022_PROGRAM_ID,
    TOKEN_PROGRAM_ID,
    getMint,
    getAssociatedTokenAddress,
} from "@solana/spl-token";
import * as anchor from "@coral-xyz/anchor";
import { BN } from "bn.js";
import lpLockIDL from './lp_escrow.json' with { type: 'json' };
import fetch from 'node-fetch';
import bs58 from 'b58'

// Configuration
const LP_LOCK_PROGRAM_ID = new PublicKey("GJBWK2HdEyyQaxNvbjw3TXWEXZXbNz6oYhNKUtj7SvBD");
const connection = new Connection(clusterApiUrl("devnet"), "confirmed");
const CHECK_INTERVAL = 10 * 60 * 1000; // Check every 10 minutes
const API_POLL_INTERVAL = 5 * 60 * 1000; // Poll API every 5 minutes for new tokens

// Oracle Manager to handle multiple tokens
class LPUnlockOracleManager {
    constructor(oracleKeypair, apiUrl) {
        this.oracleKeypair = oracleKeypair;
        this.apiUrl = apiUrl;
        this.provider = new anchor.AnchorProvider(connection, oracleKeypair, {});
        this.program = new anchor.Program(lpLockIDL, this.provider);
        this.oracles = new Map(); // Map<mintAddress, oracleInstance>
        this.isRunning = false;
        this.monitoringInterval = null;
        this.apiPollingInterval = null;
    }

    // Add a new token to monitor
    addToken(tokenConfig) {
        const { contract_address, lpMint, lockInfo, lockVault, isUnlocked } = tokenConfig;

        // Skip duplicates or already unlocked tokens
        if (this.oracles.has(contract_address) || isUnlocked) return false;

        // ✅ Validate required public keys
        const requiredKeys = { contract_address, lpMint, lockInfo };
        for (const [key, value] of Object.entries(requiredKeys)) {
            if (!value) {
                console.error(`❌ Missing value for ${key}`);
                return false;
            }
            try {
                new PublicKey(value);
            } catch {
                console.error(`❌ Invalid PublicKey for ${key}: ${value}`);
                return false;
            }
        }

        const oracle = {
            mintAddress: new PublicKey(contract_address),
            lpMintAddress: new PublicKey(lpMint),
            lockInfo: new PublicKey(lockInfo),
            lockVault: lockVaultAddress ? new PublicKey(lockVault) : null,
            lastVolumeCheck: 0,
            cumulativeVolume: 0,
            addedAt: Date.now(),
        };

        this.oracles.set(mintAddress, oracle);
        console.log(`✅ Added token to monitoring: ${mintAddress.slice(0, 8)}...`);
        return true;
    }

    // Remove a token from monitoring
    removeToken(mintAddress) {
        if (this.oracles.delete(mintAddress)) {
            console.log(`🗑️ Removed token from monitoring: ${mintAddress.slice(0, 8)}...`);
            return true;
        }
        return false;
    }

    // Fetch tokens from API and add new ones
    async syncTokensFromAPI() {
        try {
            console.log('📡 Syncing tokens from API...');
            const response = await fetch(this.apiUrl);

            if (!response.ok) {
                throw new Error(`API error: ${response.status}`);
            }

            const tokens = await response.json();

            if (!Array.isArray(tokens.data)) {
                throw new Error('API response is not an array');
            }

            let newTokensAdded = 0;
            tokens.data.forEach(token => {
                if (this.addToken(token)) {
                    newTokensAdded++;
                }
            });

            if (newTokensAdded > 0) {
                console.log(`✨ Added ${newTokensAdded} new token(s). Total monitoring: ${this.oracles.size}`);
            } else {
                console.log(`✓ No new tokens. Currently monitoring: ${this.oracles.size} token(s)`);
            }

            return newTokensAdded;
        } catch (error) {
            console.error('❌ Error syncing tokens from API:', error);
            return 0;
        }
    }

    // Get token holder count
    async getTokenHolderCount(mintAddress) {
        try {
            const res = await fetch(
                `https://data.solanatracker.io/tokens/${mintAddress}/holders`,
                {
                    headers: {
                        'x-api-key': '95a884b8-c416-4453-a028-38350cb0fa78'
                    }
                }
            );
            const data = await res.json();
            return data.total;
        } catch (error) {
            console.error(`❌ Error fetching holder count for ${mintAddress.slice(0, 8)}...:`, error.message);
            return 0;
        }
    }

    // Get trading volume
    async getTradingVolume(mintAddress) {
        try {
            const response = await fetch(
                `https://api.dexscreener.com/latest/dex/tokens/${mintAddress}`
            );

            if (!response.ok) {
                return 0;
            }

            const data = await response.json();

            if (!data.pairs || data.pairs.length === 0) {
                return 0;
            }

            let totalVolume = 0;
            data.pairs.forEach((pair) => {
                const pairVolume = parseFloat(pair.volume?.h24 || 0);
                totalVolume += pairVolume;
            });

            return totalVolume;
        } catch (error) {
            console.error(`❌ Error fetching volume for ${mintAddress.slice(0, 8)}...:`, error.message);
            return 0;
        }
    }

    // Batch update data for a token
    async batchUpdateData(oracle, holderCount, volumeToAddCents) {
        try {
            const currentTime = Math.floor(Date.now() / 1000);

            const instruction = await this.program.methods
                .batchUpdateData(
                    new BN(holderCount),
                    new BN(currentTime),
                    new BN(volumeToAddCents),
                    new BN(currentTime)
                )
                .accounts({
                    lockInfo: oracle.lockInfo,
                    oracleSigner: this.oracleKeypair.publicKey,
                })
                .instruction();

            const transaction = new Transaction().add(instruction);
            const signature = await sendAndConfirmTransaction(
                connection,
                transaction,
                [this.oracleKeypair],
                { commitment: "confirmed" }
            );

            return signature;
        } catch (error) {
            console.error(`❌ Batch update failed for ${oracle.mintAddress.toString().slice(0, 8)}...:`, error.message);
            throw error;
        }
    }

    // Check unlock conditions
    async checkUnlockConditions(oracle) {
        try {
            const instruction = await this.program.methods
                .checkUnlockConditions()
                .accounts({
                    lockInfo: oracle.lockInfo,
                })
                .instruction();

            const transaction = new Transaction().add(instruction);
            const signature = await sendAndConfirmTransaction(
                connection,
                transaction,
                [this.oracleKeypair],
                { commitment: "confirmed" }
            );

            const lockInfoData = await this.program.account.lockInfo.fetch(oracle.lockInfo);

            return {
                unlockable: lockInfoData.unlockable,
                currentHolders: lockInfoData.currentHolderCount.toNumber(),
                requiredHolders: lockInfoData.holderThreshold.toNumber(),
                currentVolume: lockInfoData.totalVolumeUsd.toNumber(),
                requiredVolume: lockInfoData.volumeThreshold.toNumber(),
                signature
            };
        } catch (error) {
            console.error(`❌ Check conditions failed for ${oracle.mintAddress.toString().slice(0, 8)}...:`, error.message);
            return {
                unlockable: false,
                signature: null,
                currentHolders: 0,
                requiredHolders: 0,
                currentVolume: 0,
                requiredVolume: 0
            };
        }
    }

    // Unlock tokens
    // Unlock tokens - burns them permanently
    async unlockTokens(oracle) {
        try {
            // If lockVault wasn't provided, derive it
            let lockVault = oracle.lockVault;
            if (!lockVault) {
                [lockVault] = PublicKey.findProgramAddressSync(
                    [Buffer.from("lock_vault"), oracle.lpMintAddress.toBuffer()],
                    LP_LOCK_PROGRAM_ID
                );
            }

            const mintInfo = await getMint(connection, oracle.lpMintAddress);
            const tokenProgramId = mintInfo.tlvData.length > 0 ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;

            const instruction = await this.program.methods
                .unlockTokens()
                .accounts({
                    lockInfo: oracle.lockInfo,
                    authority: this.oracleKeypair.publicKey,
                    lockTokenAccount: lockVault,
                    tokenMint: oracle.lpMintAddress,
                    tokenProgram: tokenProgramId,
                })
                .instruction();

            const transaction = new Transaction().add(instruction);
            const signature = await sendAndConfirmTransaction(
                connection,
                transaction,
                [this.oracleKeypair],
                { commitment: "confirmed" }
            );

            console.log(`🔥 [${oracle.mintAddress.toString().slice(0, 8)}...] TOKENS BURNED!`);
            console.log(`   LP tokens permanently removed from circulation`);
            console.log(`   Transaction: https://explorer.solana.com/tx/${signature}?cluster=devnet`);

            return signature;
        } catch (error) {
            console.error(`❌ Unlock/burn failed for ${oracle.mintAddress.toString().slice(0, 8)}...:`, error.message);
            throw error;
        }
    }

    // Monitor a single token
    async monitorToken(mintAddress) {
        const oracle = this.oracles.get(mintAddress);
        if (!oracle) return;

        try {
            // Get real-time data
            const holderCount = await this.getTokenHolderCount(mintAddress);
            const recentVolume = await this.getTradingVolume(mintAddress);
            const volumeInCents = Math.floor(recentVolume * 100);

            // For testing, uncomment these:
            // const holderCount = 200;
            // const volumeInCents = 200000 * 100;

            if (holderCount > 0 || volumeInCents > 0) {
                await this.batchUpdateData(oracle, holderCount, volumeInCents);
                console.log(`   ✓ Updated: ${holderCount} holders, $${(volumeInCents / 100).toFixed(2)} volume`);
            }

            const conditionCheck = await this.checkUnlockConditions(oracle);

            if (conditionCheck.unlockable) {
                console.log(`🎉 [${mintAddress.slice(0, 8)}...] CONDITIONS MET - UNLOCKING...`);
                await this.unlockTokens(oracle);
                this.removeToken(mintAddress);
                return { status: 'unlocked', mintAddress };
            }

            const holdersNeeded = Math.max(0, conditionCheck.requiredHolders - conditionCheck.currentHolders);
            const volumeNeeded = Math.max(0, (conditionCheck.requiredVolume - conditionCheck.currentVolume) / 100);

            console.log(`   ⏳ Need: ${holdersNeeded} holders, $${volumeNeeded.toFixed(2)} volume`);
            return { status: 'monitoring', mintAddress, holdersNeeded, volumeNeeded };

        } catch (error) {
            console.error(`❌ [${mintAddress.slice(0, 8)}...] Monitor error:`, error.message);
            return { status: 'error', mintAddress, error: error.message };
        }
    }

    // Monitor all tokens
    async monitorAllTokens() {
        if (this.oracles.size === 0) {
            console.log('⚠️ No tokens to monitor');
            return;
        }

        console.log(`\n${'='.repeat(60)}`);
        console.log(`🔍 Monitoring ${this.oracles.size} token(s) - ${new Date().toLocaleString()}`);
        console.log(`${'='.repeat(60)}`);

        const promises = Array.from(this.oracles.keys()).map(mintAddress => {
            console.log(`\n🔄 [${mintAddress.slice(0, 8)}...] Checking conditions...`);
            return this.monitorToken(mintAddress);
        });

        const results = await Promise.allSettled(promises);

        const successful = results.filter(r => r.status === 'fulfilled').length;
        const failed = results.filter(r => r.status === 'rejected').length;

        console.log(`\n${'='.repeat(60)}`);
        console.log(`✓ Cycle complete: ${successful} successful, ${failed} failed`);
        console.log(`${'='.repeat(60)}\n`);
    }

    // Start monitoring all tokens with continuous API sync
    async startMonitoring() {
        if (this.isRunning) {
            console.log('⚠️ Oracle is already running');
            return;
        }

        this.isRunning = true;
        console.log('🚀 Starting LP unlock monitoring with live API sync...');
        console.log(`📡 API URL: ${this.apiUrl}`);
        console.log(`⏰ Token check interval: ${CHECK_INTERVAL / 60000} minutes`);
        console.log(`⏰ API sync interval: ${API_POLL_INTERVAL / 60000} minutes\n`);

        // Initial API sync and monitoring
        await this.syncTokensFromAPI();
        await this.monitorAllTokens();

        // Schedule periodic token monitoring
        this.monitoringInterval = setInterval(async () => {
            await this.monitorAllTokens();
        }, CHECK_INTERVAL);

        // Schedule periodic API polling for new tokens
        this.apiPollingInterval = setInterval(async () => {
            await this.syncTokensFromAPI();
        }, API_POLL_INTERVAL);

        console.log('✅ Monitoring started successfully');
    }

    // Stop monitoring
    stopMonitoring() {
        if (this.monitoringInterval) {
            clearInterval(this.monitoringInterval);
            this.monitoringInterval = null;
        }

        if (this.apiPollingInterval) {
            clearInterval(this.apiPollingInterval);
            this.apiPollingInterval = null;
        }

        this.isRunning = false;
        console.log('🛑 Monitoring stopped');
    }

    // Get status of all tokens
    async getAllStatus() {
        const statuses = [];

        for (const [mintAddress, oracle] of this.oracles.entries()) {
            try {
                const lockInfoData = await this.program.account.lockInfo.fetch(oracle.lockInfo);
                statuses.push({
                    mintAddress,
                    lpMintAddress: oracle.lpMintAddress.toString(),
                    lockedAmount: lockInfoData.lockedAmount.toString(),
                    currentHolders: lockInfoData.currentHolderCount.toNumber(),
                    requiredHolders: lockInfoData.holderThreshold.toNumber(),
                    currentVolume: lockInfoData.totalVolumeUsd.toNumber() / 100,
                    requiredVolume: lockInfoData.volumeThreshold.toNumber() / 100,
                    unlockable: lockInfoData.unlockable,
                    monitoringDuration: Math.floor((Date.now() - oracle.addedAt) / 1000 / 60), // minutes
                });
            } catch (error) {
                console.error(`❌ Error fetching status for ${mintAddress.slice(0, 8)}...:`, error.message);
            }
        }

        return statuses;
    }

    // Get summary statistics
    getSummary() {
        return {
            totalTokens: this.oracles.size,
            isRunning: this.isRunning,
            apiUrl: this.apiUrl,
            checkInterval: CHECK_INTERVAL / 60000,
            apiPollInterval: API_POLL_INTERVAL / 60000,
        };
    }
}

// Usage
const oracleKeypair = Keypair.fromSecretKey(bs58.decode(process.env.PRIVATE_KEY));

// Initialize with your live API URL
const API_URL = process.env.API_URL;
const oracleManager = new LPUnlockOracleManager(oracleKeypair, API_URL);

// Start monitoring - it will automatically sync new tokens from API
await oracleManager.startMonitoring();

// Optional: Get current status
// const summary = oracleManager.getSummary();
// console.log(summary);

// Optional: Get detailed status of all tokens
// const statuses = await oracleManager.getAllStatus();
// console.log(statuses);

// Optional: Stop monitoring
// oracleManager.stopMonitoring();

export { LPUnlockOracleManager };