import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { LpEscrow } from "../target/types/lp_escrow";
import { 
  createMint, 
  createAccount, 
  mintTo, 
  getAccount,
  TOKEN_PROGRAM_ID,
  createInitializeAccountInstruction,
  getMinimumBalanceForRentExemptAccount,
  ACCOUNT_SIZE
} from "@solana/spl-token";
import { expect } from "chai";

describe("lp_escrow", () => {
  // Configure the client to use the local cluster
  anchor.setProvider(anchor.AnchorProvider.env());

  const program = anchor.workspace.LpEscrow as Program<LpEscrow>;
  const provider = anchor.AnchorProvider.env();
  
  let tokenMint: anchor.web3.PublicKey;
  let authorityTokenAccount: anchor.web3.PublicKey;
  let lockInfo: anchor.web3.PublicKey;
  let lockVault: anchor.web3.PublicKey;
  let authority: anchor.web3.Keypair;
  let oracleAuthority: anchor.web3.Keypair;

  const LOCK_AMOUNT = new anchor.BN(1_000_000_000); // 1 billion tokens
  const HOLDER_THRESHOLD = new anchor.BN(100);
  const VOLUME_THRESHOLD_USD = new anchor.BN(50_000_00); // $50,000 in cents

  before(async () => {
    authority = anchor.web3.Keypair.generate();
    oracleAuthority = anchor.web3.Keypair.generate();

    // Airdrop SOL to authority and oracle
    const airdropSig = await provider.connection.requestAirdrop(
      authority.publicKey,
      2 * anchor.web3.LAMPORTS_PER_SOL
    );
    await provider.connection.confirmTransaction(airdropSig);

    const oracleAirdrop = await provider.connection.requestAirdrop(
      oracleAuthority.publicKey,
      1 * anchor.web3.LAMPORTS_PER_SOL
    );
    await provider.connection.confirmTransaction(oracleAirdrop);

    // Create token mint
    tokenMint = await createMint(
      provider.connection,
      authority,
      authority.publicKey,
      null,
      9
    );

    // Create token account for authority
    authorityTokenAccount = await createAccount(
      provider.connection,
      authority,
      tokenMint,
      authority.publicKey
    );

    // Mint tokens to authority
    await mintTo(
      provider.connection,
      authority,
      tokenMint,
      authorityTokenAccount,
      authority,
      LOCK_AMOUNT.toNumber()
    );

    // Derive PDAs
    [lockInfo] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("lock"), tokenMint.toBuffer()],
      program.programId
    );

    [lockVault] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("lock_vault"), tokenMint.toBuffer()],
      program.programId
    );
  });

  it("Initializes lock with correct parameters", async () => {
    const tx = await program.methods
      .initializeLock(
        tokenMint,
        LOCK_AMOUNT,
        HOLDER_THRESHOLD,
        VOLUME_THRESHOLD_USD,
        oracleAuthority.publicKey
      )
      .accounts({
        lockInfo,
        authority: authority.publicKey,
        fromTokenAccount: authorityTokenAccount,
        tokenMint,
        lockTokenAccount: lockVault,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .signers([authority])
      .rpc();

    console.log("Initialize lock transaction signature", tx);

    // Verify lock info account
    const lockInfoAccount = await program.account.lockInfo.fetch(lockInfo);
    expect(lockInfoAccount.authority.toString()).to.equal(authority.publicKey.toString());
    expect(lockInfoAccount.tokenMint.toString()).to.equal(tokenMint.toString());
    expect(lockInfoAccount.lockedAmount.toString()).to.equal(LOCK_AMOUNT.toString());
    expect(lockInfoAccount.holderThreshold.toString()).to.equal(HOLDER_THRESHOLD.toString());
    expect(lockInfoAccount.volumeThreshold.toString()).to.equal(VOLUME_THRESHOLD_USD.toString());
    expect(lockInfoAccount.oracleAuthority.toString()).to.equal(oracleAuthority.publicKey.toString());
    expect(lockInfoAccount.unlockable).to.be.false;
    expect(lockInfoAccount.totalVolumeUsd.toString()).to.equal("0");
    expect(lockInfoAccount.currentHolderCount.toString()).to.equal("0");

    // Verify tokens were transferred to vault
    const vaultAccount = await getAccount(provider.connection, lockVault);
    expect(vaultAccount.amount.toString()).to.equal(LOCK_AMOUNT.toString());
  });

  it("Updates holder count via oracle", async () => {
    const newHolderCount = new anchor.BN(50);
    const timestamp = Math.floor(Date.now() / 1000);

    await program.methods
      .updateHolderCount(newHolderCount, new anchor.BN(timestamp))
      .accounts({
        lockInfo,
        oracleSigner: oracleAuthority.publicKey,
      })
      .signers([oracleAuthority])
      .rpc();

    const lockInfoAccount = await program.account.lockInfo.fetch(lockInfo);
    expect(lockInfoAccount.currentHolderCount.toString()).to.equal(newHolderCount.toString());
  });

  it("Fails to update holder count with unauthorized oracle", async () => {
    const unauthorizedOracle = anchor.web3.Keypair.generate();
    
    // Airdrop for transaction fees
    const airdrop = await provider.connection.requestAirdrop(
      unauthorizedOracle.publicKey,
      1 * anchor.web3.LAMPORTS_PER_SOL
    );
    await provider.connection.confirmTransaction(airdrop);

    try {
      await program.methods
        .updateHolderCount(new anchor.BN(100), new anchor.BN(Math.floor(Date.now() / 1000)))
        .accounts({
          lockInfo,
          oracleSigner: unauthorizedOracle.publicKey,
        })
        .signers([unauthorizedOracle])
        .rpc();
      
      expect.fail("Should have failed with unauthorized oracle");
    } catch (err) {
      expect(err.error.errorMessage).to.include("Unauthorized oracle");
    }
  });

  it("Records trade volume via oracle", async () => {
    const tokenAmount = new anchor.BN(1_000_000);
    const usdValueCents = new anchor.BN(5_000_00); // $5,000
    const timestamp = Math.floor(Date.now() / 1000);

    await program.methods
      .recordTradeVolume(tokenAmount, usdValueCents, new anchor.BN(timestamp))
      .accounts({
        lockInfo,
        oracleSigner: oracleAuthority.publicKey,
      })
      .signers([oracleAuthority])
      .rpc();

    const lockInfoAccount = await program.account.lockInfo.fetch(lockInfo);
    expect(lockInfoAccount.totalVolumeUsd.toString()).to.equal(usdValueCents.toString());
  });

  it("Batch updates holder count and volume", async () => {
    const newHolderCount = new anchor.BN(120);
    const holderTimestamp = Math.floor(Date.now() / 1000);
    const volumeToAdd = new anchor.BN(50_000_00); // $50,000
    const volumeTimestamp = Math.floor(Date.now() / 1000);

    await program.methods
      .batchUpdateData(
        newHolderCount,
        new anchor.BN(holderTimestamp),
        volumeToAdd,
        new anchor.BN(volumeTimestamp)
      )
      .accounts({
        lockInfo,
        oracleSigner: oracleAuthority.publicKey,
      })
      .signers([oracleAuthority])
      .rpc();

    const lockInfoAccount = await program.account.lockInfo.fetch(lockInfo);
    expect(lockInfoAccount.currentHolderCount.toString()).to.equal(newHolderCount.toString());
    // Total should be previous (5000) + new (50000) = 55000
    expect(lockInfoAccount.totalVolumeUsd.toNumber()).to.be.greaterThan(50_000_00);
  });

  it("Checks and meets unlock conditions", async () => {
    await program.methods
      .checkUnlockConditions()
      .accounts({
        lockInfo,
      })
      .rpc();

    const lockInfoAccount = await program.account.lockInfo.fetch(lockInfo);
    expect(lockInfoAccount.unlockable).to.be.true;
    expect(lockInfoAccount.conditionsMetAt.toNumber()).to.be.greaterThan(0);
  });

  it("Unlocks tokens after conditions are met", async () => {
    // Create a raw token account manually
    const destinationTokenAccountKeypair = anchor.web3.Keypair.generate();
    
    const rentExemptBalance = await getMinimumBalanceForRentExemptAccount(provider.connection);
    
    const createAccountIx = anchor.web3.SystemProgram.createAccount({
      fromPubkey: authority.publicKey,
      newAccountPubkey: destinationTokenAccountKeypair.publicKey,
      lamports: rentExemptBalance,
      space: ACCOUNT_SIZE,
      programId: TOKEN_PROGRAM_ID,
    });

    const initAccountIx = createInitializeAccountInstruction(
      destinationTokenAccountKeypair.publicKey,
      tokenMint,
      authority.publicKey,
      TOKEN_PROGRAM_ID
    );

    // Create the token account
    const createTx = new anchor.web3.Transaction().add(createAccountIx, initAccountIx);
    await provider.sendAndConfirm(createTx, [authority, destinationTokenAccountKeypair]);

    // Now unlock tokens
    await program.methods
      .unlockTokens()
      .accounts({
        lockInfo,
        authority: authority.publicKey,
        lockTokenAccount: lockVault,
        toTokenAccount: destinationTokenAccountKeypair.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([authority])
      .rpc();

    // Verify tokens were transferred
    const destinationAccount = await getAccount(provider.connection, destinationTokenAccountKeypair.publicKey);
    expect(destinationAccount.amount.toString()).to.equal(LOCK_AMOUNT.toString());

    const vaultAccount = await getAccount(provider.connection, lockVault);
    expect(vaultAccount.amount.toString()).to.equal("0");
  });

  it("Updates oracle authority", async () => {
    const newOracle = anchor.web3.Keypair.generate();

    // Need to reinitialize for this test since tokens were unlocked
    const newTokenMint = await createMint(
      provider.connection,
      authority,
      authority.publicKey,
      null,
      9
    );

    const newAuthorityTokenAccount = await createAccount(
      provider.connection,
      authority,
      newTokenMint,
      authority.publicKey
    );

    await mintTo(
      provider.connection,
      authority,
      newTokenMint,
      newAuthorityTokenAccount,
      authority,
      LOCK_AMOUNT.toNumber()
    );

    const [newLockInfo] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("lock"), newTokenMint.toBuffer()],
      program.programId
    );

    const [newLockVault] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("lock_vault"), newTokenMint.toBuffer()],
      program.programId
    );

    await program.methods
      .initializeLock(
        newTokenMint,
        LOCK_AMOUNT,
        HOLDER_THRESHOLD,
        VOLUME_THRESHOLD_USD,
        oracleAuthority.publicKey
      )
      .accounts({
        lockInfo: newLockInfo,
        authority: authority.publicKey,
        fromTokenAccount: newAuthorityTokenAccount,
        tokenMint: newTokenMint,
        lockTokenAccount: newLockVault,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .signers([authority])
      .rpc();

    // Now update oracle authority
    await program.methods
      .updateOracleAuthority(newOracle.publicKey)
      .accounts({
        lockInfo: newLockInfo,
        currentAuthority: authority.publicKey,
      })
      .signers([authority])
      .rpc();

    const lockInfoAccount = await program.account.lockInfo.fetch(newLockInfo);
    expect(lockInfoAccount.oracleAuthority.toString()).to.equal(newOracle.publicKey.toString());
  });
});