use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer, Burn};
declare_id!("6DtxHJTWasdLjAXizDCMrH69KfEsTaE1FbU2a4aTa57C");

#[program]
pub mod lp_escrow {
    use super::*;

    // 30 days in seconds
    const THIRTY_DAYS_SECONDS: i64 = 30 * 24 * 60 * 60; // 2,592,000 seconds

    pub fn initialize_lock(
        ctx: Context<InitializeLock>,
        token_mint: Pubkey,
        lock_amount: u64,
        holder_threshold: u64,
        volume_threshold_usd: u64,
        oracle_authority: Pubkey,
    ) -> Result<()> {
        let lock_info = &mut ctx.accounts.lock_info;
        lock_info.authority = ctx.accounts.authority.key();
        lock_info.token_mint = token_mint;
        lock_info.locked_amount = lock_amount;
        lock_info.holder_threshold = holder_threshold;
        lock_info.volume_threshold = volume_threshold_usd;
        lock_info.oracle_authority = oracle_authority;
        lock_info.unlockable = false;
        lock_info.created_at = Clock::get()?.unix_timestamp;
        lock_info.total_volume_usd = 0;
        lock_info.current_holder_count = 0;

        // Transfer tokens to lock vault
        let transfer_ctx = CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.from_token_account.to_account_info(),
                to: ctx.accounts.lock_token_account.to_account_info(),
                authority: ctx.accounts.authority.to_account_info(),
            },
        );

        token::transfer(transfer_ctx, lock_amount)?;

        msg!("🔒 LP Lock initialized: {} tokens, {}+ holders, ${}+ volume", 
             lock_amount, holder_threshold, volume_threshold_usd / 100);
        msg!("⏰ Will auto-unlock after 30 days regardless of conditions");
        Ok(())
    }

    /// Called by authorized oracle to update holder count with offchain validation
    pub fn update_holder_count(
        ctx: Context<UpdateHolderCount>,
        new_holder_count: u64,
        data_timestamp: i64,
    ) -> Result<()> {
        let lock_info = &mut ctx.accounts.lock_info;

        // Verify oracle authority
        require!(
            ctx.accounts.oracle_signer.key() == lock_info.oracle_authority,
            ErrorCode::UnauthorizedOracle
        );

        // Basic timestamp validation (data shouldn't be too old)
        let current_time = Clock::get()?.unix_timestamp;
        require!(
            current_time - data_timestamp < 3600, // 1 hour staleness limit
            ErrorCode::StaleHolderData
        );

        lock_info.current_holder_count = new_holder_count;
        lock_info.holder_data_updated_at = data_timestamp;

        msg!("📊 Holder count updated: {} (timestamp: {})", new_holder_count, data_timestamp);
        Ok(())
    }

    /// Record trade volume with offchain price validation
    pub fn record_trade_volume(
        ctx: Context<RecordTradeVolume>,
        token_amount: u64,
        usd_value_cents: u64, // USD value in cents, validated offchain
        price_timestamp: i64,
    ) -> Result<()> {
        let lock_info = &mut ctx.accounts.lock_info;
        let current_time = Clock::get()?.unix_timestamp;

        // Verify oracle authority
        require!(
            ctx.accounts.oracle_signer.key() == lock_info.oracle_authority,
            ErrorCode::UnauthorizedOracle
        );

        // Basic timestamp validation (price data shouldn't be too old)
        require!(
            current_time - price_timestamp < 300, // 5 minutes staleness limit
            ErrorCode::StalePriceData
        );

        // Basic sanity check - prevent extremely large values
        require!(
            usd_value_cents < 100_000_000_000, // $1B limit
            ErrorCode::InvalidTradeValue
        );

        lock_info.total_volume_usd = lock_info.total_volume_usd.saturating_add(usd_value_cents);

        msg!("💰 Trade recorded: {} tokens = ${} (total: ${})", 
             token_amount, usd_value_cents / 100, lock_info.total_volume_usd / 100);

        Ok(())
    }

    /// Batch update both holder count and volume (gas efficient)
    pub fn batch_update_data(
        ctx: Context<BatchUpdateData>,
        new_holder_count: u64,
        holder_data_timestamp: i64,
        volume_to_add_cents: u64,
        volume_price_timestamp: i64,
    ) -> Result<()> {
        let lock_info = &mut ctx.accounts.lock_info;
        let current_time = Clock::get()?.unix_timestamp;

        // Verify oracle authority
        require!(
            ctx.accounts.oracle_signer.key() == lock_info.oracle_authority,
            ErrorCode::UnauthorizedOracle
        );

        // Validate timestamps
        require!(
            current_time - holder_data_timestamp < 3600, // 1 hour for holder data
            ErrorCode::StaleHolderData
        );
        require!(
            current_time - volume_price_timestamp < 300, // 5 minutes for price data
            ErrorCode::StalePriceData
        );

        // Update holder count
        lock_info.current_holder_count = new_holder_count;
        lock_info.holder_data_updated_at = holder_data_timestamp;

        // Update volume
        lock_info.total_volume_usd = lock_info.total_volume_usd.saturating_add(volume_to_add_cents);

        msg!("📊 Batch update: {} holders, +${} volume (total: ${})",
             new_holder_count, volume_to_add_cents / 100, lock_info.total_volume_usd / 100);

        Ok(())
    }

    /// Check if unlock conditions are met (milestone OR 30-day time limit)
    pub fn check_unlock_conditions(ctx: Context<CheckConditions>) -> Result<()> {
        let lock_info = &mut ctx.accounts.lock_info;
        let clock = Clock::get()?;
        let current_time = clock.unix_timestamp;

        let holder_count = lock_info.current_holder_count;
        let volume_usd = lock_info.total_volume_usd;

        // Calculate time elapsed
        let time_elapsed = current_time - lock_info.created_at;
        let days_elapsed = time_elapsed / (24 * 60 * 60);

        msg!("🔍 Checking unlock conditions:");
        msg!("   ⏰ Time: {} days elapsed (need 30 days)", days_elapsed);
        msg!("   👥 Holders: {} (need {})", holder_count, lock_info.holder_threshold);
        msg!("   💰 Volume: ${} (need ${})", volume_usd / 100, lock_info.volume_threshold / 100);

        // Check milestone conditions
        let milestone_conditions_met = holder_count >= lock_info.holder_threshold 
            && volume_usd >= lock_info.volume_threshold;

        // Check time condition (30 days passed)
        let time_condition_met = time_elapsed >= THIRTY_DAYS_SECONDS;

        // Unlock if EITHER milestone conditions OR time condition is met
        if milestone_conditions_met {
            lock_info.unlockable = true;
            if lock_info.conditions_met_at == 0 {
                lock_info.conditions_met_at = current_time;
            }
            msg!("🎉 UNLOCK CONDITIONS MET (Milestone)! 🎉");
            msg!("   ✅ Both holder and volume thresholds reached");
        } else if time_condition_met {
            lock_info.unlockable = true;
            if lock_info.conditions_met_at == 0 {
                lock_info.conditions_met_at = current_time;
            }
            msg!("🎉 UNLOCK CONDITIONS MET (30-Day Limit)! 🎉");
            msg!("   ⏰ 30 days have passed since lock creation");
        } else {
            let days_remaining = 30 - days_elapsed;
            msg!("❌ Conditions not yet met");
            msg!("   Need {} more holders OR {} more days", 
                 lock_info.holder_threshold.saturating_sub(holder_count),
                 days_remaining.max(0));
            msg!("   Need ${} more volume OR {} more days", 
                 (lock_info.volume_threshold.saturating_sub(volume_usd)) / 100,
                 days_remaining.max(0));
        }

        Ok(())
    }

    /// Unlock tokens once conditions are met
    pub fn unlock_tokens(ctx: Context<UnlockTokens>) -> Result<()> {
        let lock_info = &ctx.accounts.lock_info;
    
        require!(lock_info.unlockable, ErrorCode::ConditionsNotMet);
        require!(
            ctx.accounts.authority.key() == lock_info.authority,
            ErrorCode::Unauthorized
        );
    
        // Burn tokens using PDA as authority
        let seeds = &[
            b"lock",
            lock_info.token_mint.as_ref(),
            &[ctx.bumps.lock_info],
        ];
        let signer_seeds = &[&seeds[..]];
    
        let burn_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Burn {
                mint: ctx.accounts.token_mint.to_account_info(),
                from: ctx.accounts.lock_token_account.to_account_info(),
                authority: ctx.accounts.lock_info.to_account_info(),
            },
            signer_seeds,
        );
    
        token::burn(burn_ctx, lock_info.locked_amount)?;
    
        msg!("🔥 TOKENS BURNED! {} tokens permanently removed from circulation", lock_info.locked_amount);
        Ok(())
    }
    /// Emergency update oracle authority (multi-sig recommended)
    pub fn update_oracle_authority(
        ctx: Context<UpdateOracleAuthority>,
        new_oracle_authority: Pubkey,
    ) -> Result<()> {
        let lock_info = &mut ctx.accounts.lock_info;
        
        require!(
            ctx.accounts.current_authority.key() == lock_info.authority,
            ErrorCode::Unauthorized
        );

        lock_info.oracle_authority = new_oracle_authority;
        msg!("🔄 Oracle authority updated to: {}", new_oracle_authority);
        Ok(())
    }
}

// Account contexts
#[derive(Accounts)]
pub struct InitializeLock<'info> {
    #[account(
        init,
        payer = authority,
        space = 8 + LockInfo::LEN,
        seeds = [b"lock", token_mint.key().as_ref()],
        bump
    )]
    pub lock_info: Account<'info, LockInfo>,

    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        mut,
        constraint = from_token_account.mint == token_mint.key(),
        constraint = from_token_account.owner == authority.key()
    )]
    pub from_token_account: Account<'info, TokenAccount>,

    pub token_mint: Account<'info, Mint>,

    #[account(
        init,
        payer = authority,
        token::mint = token_mint,
        token::authority = lock_info,
        seeds = [b"lock_vault", token_mint.key().as_ref()],
        bump
    )]
    pub lock_token_account: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct TestForceConditions<'info> {
    #[account(mut)]
    pub lock_info: Account<'info, LockInfo>,
    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct UpdateHolderCount<'info> {
    #[account(mut)]
    pub lock_info: Account<'info, LockInfo>,
    pub oracle_signer: Signer<'info>,
}

#[derive(Accounts)]
pub struct RecordTradeVolume<'info> {
    #[account(mut)]
    pub lock_info: Account<'info, LockInfo>,
    pub oracle_signer: Signer<'info>,
}

#[derive(Accounts)]
pub struct BatchUpdateData<'info> {
    #[account(mut)]
    pub lock_info: Account<'info, LockInfo>,
    pub oracle_signer: Signer<'info>,
}

#[derive(Accounts)]
pub struct CheckConditions<'info> {
    #[account(mut)]
    pub lock_info: Account<'info, LockInfo>,
}

#[derive(Accounts)]
pub struct UnlockTokens<'info> {
    #[account(
        mut,
        seeds = [b"lock", lock_info.token_mint.as_ref()],
        bump
    )]
    pub lock_info: Account<'info, LockInfo>,

    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        mut,
        seeds = [b"lock_vault", lock_info.token_mint.as_ref()],
        bump,
        constraint = lock_token_account.mint == lock_info.token_mint
    )]
    pub lock_token_account: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = token_mint.key() == lock_info.token_mint
    )]
    pub token_mint: Account<'info, Mint>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct UpdateOracleAuthority<'info> {
    #[account(mut)]
    pub lock_info: Account<'info, LockInfo>,
    pub current_authority: Signer<'info>,
}

#[account]
pub struct LockInfo {
    pub authority: Pubkey,              // 32
    pub token_mint: Pubkey,             // 32
    pub locked_amount: u64,             // 8
    pub holder_threshold: u64,          // 8
    pub volume_threshold: u64,          // 8 (USD cents)
    pub oracle_authority: Pubkey,       // 32
    pub unlockable: bool,               // 1
    pub created_at: i64,                // 8
    pub conditions_met_at: i64,         // 8
    pub total_volume_usd: u64,          // 8 (USD cents)
    pub current_holder_count: u64,      // 8
    pub holder_data_updated_at: i64,    // 8
}

impl LockInfo {
    pub const LEN: usize = 32 + 32 + 8 + 8 + 8 + 32 + 1 + 8 + 8 + 8 + 8 + 8;
}

#[error_code]
pub enum ErrorCode {
    #[msg("Unlock conditions not yet met")]
    ConditionsNotMet,
    #[msg("Unauthorized access")]
    Unauthorized,
    #[msg("Unauthorized oracle")]
    UnauthorizedOracle,
    #[msg("Holder count data is stale")]
    StaleHolderData,
    #[msg("Price data is stale")]
    StalePriceData,
    #[msg("Invalid trade value")]
    InvalidTradeValue,
}