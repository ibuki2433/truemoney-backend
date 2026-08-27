/**
 * =========================================================================
 * Ibuki Ch. (最京いぶき) — TrueMoney Gift Voucher Donation Backend API
 * Node.js (Express) + Supabase + Discord Webhook
 * Receiver Phone: 086-371-4416 (Configurable via .env TRUEMONEY_PHONE)
 * =========================================================================
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors({ origin: '*' }));
app.use(express.json());
app.use(express.static(__dirname));

// ==========================================
// 1. CONFIGURATION
// ==========================================
const RECEIVER_PHONE = (process.env.TRUEMONEY_PHONE || '0863714416').replace(/[^0-9]/g, '');
const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || '';
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL || '';
const GOAL_TARGET = 10000;

let supabase = null;
if (SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY && !SUPABASE_URL.includes('your-project')) {
  supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  console.log('✅ Supabase connected successfully.');
} else {
  console.log('ℹ️ Supabase not configured — using in-memory storage for real-time tracking.');
}

// ==========================================
// IN-MEMORY STORAGE (Fallback เมื่อยังไม่ได้ต่อ Supabase)
// จะเก็บข้อมูลจริงจากการโดเนทจริงเท่านั้น
// ==========================================
const memoryStore = {
  donations: [],      // Array of { donor_name, message, amount, voucher_code, status, created_at }
  usedVouchers: new Set()  // ป้องกันซองซ้ำ
};

// Helper: Mask phone for privacy logs
function maskPhone(phone) {
  if (!phone || phone.length < 7) return phone || 'N/A';
  return phone.slice(0, 3) + '****' + phone.slice(-3);
}

// Helper: Send Discord Webhook
async function sendDiscordNotification({ donorName, message, amount, voucherCode }) {
  if (!DISCORD_WEBHOOK_URL || DISCORD_WEBHOOK_URL.includes('your-webhook-id')) return;

  try {
    const formattedAmount = Number(amount).toLocaleString('th-TH', { minimumFractionDigits: 2 });
    await axios.post(DISCORD_WEBHOOK_URL, {
      username: 'Ibuki Donation Hub',
      avatar_url: 'https://yt3.googleusercontent.com/OBkYl58Z5epxx3jW09CTYbX2Xlv4I68fewCAHYM0oOb7eeUDegMFyDwPQuiPRbUYmlf-BVAZBhg=s900-c-k-c0x00ffffff-no-rj',
      embeds: [
        {
          title: '🍵 มีการโดเนทค่าบำรุงช่องใหม่เข้ามา! (TrueMoney Wallet)',
          description: `ขอบคุณ **คุณ ${donorName}** ที่ร่วมสนับสนุน Ibuki Ch. 💜💖`,
          color: 0x10B981,
          fields: [
            { name: '💰 ยอดเงินโดเนท', value: `**${formattedAmount} บาท**`, inline: true },
            { name: '👤 ผู้สนับสนุน', value: donorName, inline: true },
            { name: '💬 ข้อความถึง Ibuki', value: message ? `> *"${message}"*` : '*ไม่มีข้อความ*', inline: false }
          ],
          thumbnail: {
            url: 'https://yt3.googleusercontent.com/OBkYl58Z5epxx3jW09CTYbX2Xlv4I68fewCAHYM0oOb7eeUDegMFyDwPQuiPRbUYmlf-BVAZBhg=s900-c-k-c0x00ffffff-no-rj'
          },
          footer: {
            text: `Ibuki Ch. 最京いぶき • Voucher: ${voucherCode.slice(0, 8)}...`,
            icon_url: 'https://yt3.googleusercontent.com/OBkYl58Z5epxx3jW09CTYbX2Xlv4I68fewCAHYM0oOb7eeUDegMFyDwPQuiPRbUYmlf-BVAZBhg=s900-c-k-c0x00ffffff-no-rj'
          },
          timestamp: new Date().toISOString()
        }
      ]
    });
    console.log('📢 Discord notification sent.');
  } catch (err) {
    console.error('❌ Failed to send Discord Webhook:', err.message);
  }
}

// ==========================================
// 2. API ENDPOINTS
// ==========================================

/**
 * POST /api/donate
 * แลกซองของขวัญ TrueMoney Wallet เข้าเบอร์ RECEIVER_PHONE (0863714416)
 */
app.post('/api/donate', async (req, res) => {
  // รองรับทั้ง camelCase และ snake_case
  const voucherUrl = req.body.voucherUrl || req.body.gift_url || req.body.giftUrl;
  const donorName = req.body.donorName || req.body.sender_name || req.body.donor_name || 'ผู้ไม่ประสงค์ออกนาม';
  const message = req.body.message || '';

  // 1. ตรวจสอบและดึงรหัส Voucher Code จาก URL
  if (!voucherUrl) {
    return res.status(400).json({ success: false, message: 'กรุณากรอกลิงก์ซองของขวัญ TrueMoney Wallet' });
  }

  let voucherCode = null;
  const codeMatch = voucherUrl.match(/v=([a-zA-Z0-9_-]+)/) || voucherUrl.match(/\/vouchers\/([a-zA-Z0-9_-]+)/);
  if (codeMatch && codeMatch[1]) {
    voucherCode = codeMatch[1];
  } else if (/^[a-zA-Z0-9_-]{8,64}$/.test(voucherUrl.trim())) {
    voucherCode = voucherUrl.trim();
  }

  if (!voucherCode) {
    return res.status(400).json({ 
      success: false, 
      message: 'รูปแบบลิงก์ซองอั่งเปาไม่ถูกต้อง (ต้องมี ?v=...)' 
    });
  }

  // 2. ตรวจสอบซองซ้ำ
  if (supabase) {
    try {
      const { data: existing } = await supabase
        .from('donations')
        .select('id, voucher_code')
        .eq('voucher_code', voucherCode)
        .maybeSingle();

      if (existing) {
        return res.status(400).json({
          success: false,
          message: 'ซองของขวัญนี้ถูกใช้งานหรือบันทึกในระบบไปแล้ว'
        });
      }
    } catch (dbCheckErr) {
      console.warn('DB check error:', dbCheckErr.message);
    }
  } else {
    // ตรวจสอบซ้ำจาก in-memory
    if (memoryStore.usedVouchers.has(voucherCode)) {
      return res.status(400).json({
        success: false,
        message: 'ซองของขวัญนี้ถูกใช้งานหรือบันทึกในระบบไปแล้ว'
      });
    }
  }

  try {
    console.log(`🎁 กำลังแลกซอง [${voucherCode}] เข้าเบอร์ [${maskPhone(RECEIVER_PHONE)}]...`);

    // 3. ส่งคำสั่งดึงเงินไปยัง API ของ TrueMoney Wallet
    let response;
    let amount = 0;

    try {
      // Endpoint 1: Standard Campaign Voucher Redeem
      response = await axios.post(
        `https://gift.truemoney.com/campaign/vouchers/${voucherCode}/redeem`,
        {
          mobile: RECEIVER_PHONE,
          voucher_hash: voucherCode
        },
        {
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json',
            'Origin': 'https://gift.truemoney.com',
            'Referer': `https://gift.truemoney.com/campaign/?v=${voucherCode}`,
            'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
          },
          timeout: 12000
        }
      );
    } catch (firstErr) {
      // Endpoint 2: Fallback v2 giftcards
      try {
        response = await axios.post(
          `https://gift.truemoney.com/v2/giftcards/${voucherCode}/redeem`,
          {
            mobile: RECEIVER_PHONE,
            voucher_hash: voucherCode
          },
          {
            headers: { 
              'Content-Type': 'application/json',
              'Accept': 'application/json',
              'Origin': 'https://gift.truemoney.com',
              'Referer': `https://gift.truemoney.com/campaign/?v=${voucherCode}`,
              'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
            },
            timeout: 12000
          }
        );
      } catch (secondErr) {
        throw firstErr; // Throw initial error
      }
    }

    const resData = response.data || {};
    const statusCode = resData.status?.code;

    if (statusCode === 'SUCCESS') {
      // ดึงยอดเงินที่ได้รับจริง (บาท)
      if (resData.data?.my_ticket?.amount_baht) {
        amount = parseFloat(resData.data.my_ticket.amount_baht);
      } else if (resData.data?.voucher?.redeemed_amount_baht) {
        amount = parseFloat(resData.data.voucher.redeemed_amount_baht);
      } else if (resData.data?.voucher?.amount_baht) {
        amount = parseFloat(resData.data.voucher.amount_baht);
      }

      if (isNaN(amount) || amount <= 0) amount = 10.00;

      // 4. บันทึกลง Database
      const cleanDonorName = (donorName || 'ผู้ไม่ประสงค์ออกนาม').trim().slice(0, 100);
      const cleanMessage = (message || '').trim().slice(0, 500);

      if (supabase) {
        try {
          await supabase.from('donations').insert([
            {
              donor_name: cleanDonorName,
              message: cleanMessage,
              amount: amount,
              voucher_code: voucherCode,
              status: 'SUCCESS'
            }
          ]);
          console.log(`💾 บันทึกยอด ${amount} บาท จาก ${cleanDonorName} ลง Supabase สำเร็จ`);
        } catch (dbInsertErr) {
          console.error('❌ Supabase Insert Error:', dbInsertErr.message);
        }
      } else {
        // บันทึกลง in-memory storage
        memoryStore.donations.unshift({
          donor_name: cleanDonorName,
          message: cleanMessage,
          amount: amount,
          voucher_code: voucherCode,
          status: 'SUCCESS',
          created_at: new Date().toISOString()
        });
        memoryStore.usedVouchers.add(voucherCode);
        // เก็บสูงสุด 100 รายการ
        if (memoryStore.donations.length > 100) memoryStore.donations.pop();
        console.log(`💾 บันทึกยอด ${amount} บาท จาก ${cleanDonorName} ลง in-memory สำเร็จ`);
      }

      // 5. ส่งการแจ้งเตือนเข้า Discord Webhook
      sendDiscordNotification({
        donorName: cleanDonorName,
        message: cleanMessage,
        amount: amount,
        voucherCode: voucherCode
      });

      return res.json({
        success: true,
        message: 'โดเนทสำเร็จ! ขอบคุณสำหรับการสนับสนุน',
        data: {
          donorName: cleanDonorName,
          message: cleanMessage,
          amount: amount
        }
      });

    } else {
      let errMsg = resData.status?.message || 'ซองนี้ถูกใช้งานไปแล้ว หรือหมดอายุ';
      if (statusCode === 'CANNOT_GET_OWN_VOUCHER') {
        errMsg = 'ไม่สามารถรับซองของตนเองได้ (ซองนี้สร้างจากเบอร์รับเงิน ต้องใช้เบอร์ TrueMoney อื่นสร้างซองเพื่อทดสอบครับ)';
      }
      return res.status(400).json({ success: false, message: errMsg });
    }

  } catch (error) {
    const errorData = error.response?.data;
    const statusMsg = typeof errorData === 'object' ? errorData?.status?.message : null;
    const statusCode = typeof errorData === 'object' ? errorData?.status?.code : null;
    
    let userFriendlyMsg = 'ไม่สามารถเติมเงินได้ กรุณาตรวจสอบลิงก์อีกครั้ง';
    if (statusCode === 'CANNOT_GET_OWN_VOUCHER') {
      userFriendlyMsg = 'ไม่สามารถรับซองของตนเองได้ (ซองนี้สร้างจากเบอร์ 0863714416 ซึ่งเป็นเบอร์รับเงิน ต้องใช้เบอร์ TrueMoney อื่นสร้างซองเพื่อทดสอบครับ)';
    } else if (statusCode === 'VOUCHER_OUT_OF_STOCK') {
      userFriendlyMsg = 'ซองของขวัญนี้ถูกผู้อื่นรับไปหมดแล้ว';
    } else if (statusCode === 'VOUCHER_EXPIRED') {
      userFriendlyMsg = 'ซองของขวัญนี้หมดอายุแล้ว (อายุซอง 72 ชั่วโมง)';
    } else if (statusCode === 'TARGET_USER_REDEEMED') {
      userFriendlyMsg = 'เบอร์นี้ (086-371-4416) ได้รับเงินจากซองของขวัญนี้ไปแล้ว';
    } else if (statusCode === 'VOUCHER_NOT_FOUND') {
      userFriendlyMsg = 'ไม่พบรหัสซองของขวัญนี้ กรุณาตรวจสอบลิงก์อีกครั้ง';
    } else if (statusMsg) {
      userFriendlyMsg = statusMsg;
    }

    console.error('❌ Error Redeeming TrueMoney Gift:', statusCode || statusMsg || error.message);
    return res.status(400).json({ success: false, message: userFriendlyMsg });
  }
});

/**
 * GET /api/stats
 * สถิติยอดโดเนทแบบ Real-time (ดึงจาก Supabase หรือ in-memory)
 */
app.get('/api/stats', async (req, res) => {
  if (!supabase) {
    // คำนวณจาก in-memory (ข้อมูลจริงเท่านั้น)
    const successDonations = memoryStore.donations.filter(d => d.status === 'SUCCESS');
    const sum = successDonations.reduce((acc, d) => acc + (parseFloat(d.amount) || 0), 0);
    const count = successDonations.length;
    const pct = GOAL_TARGET > 0 ? Math.min(Math.round((sum / GOAL_TARGET) * 1000) / 10, 100) : 0;

    return res.json({
      success: true,
      data: { total_amount: sum, total_count: count, target_amount: GOAL_TARGET, percentage: pct }
    });
  }

  try {
    const { data, error } = await supabase.rpc('get_monthly_donation_stats');
    if (!error && data && data.length > 0) {
      return res.json({ success: true, data: data[0] });
    }

    const startOfMonth = new Date();
    startOfMonth.setDate(1);
    startOfMonth.setHours(0, 0, 0, 0);

    const { data: list } = await supabase
      .from('donations')
      .select('amount')
      .gte('created_at', startOfMonth.toISOString())
      .eq('status', 'SUCCESS');

    const sum = (list || []).reduce((acc, curr) => acc + (parseFloat(curr.amount) || 0), 0);
    const count = (list || []).length;
    const pct = Math.min(Math.round((sum / GOAL_TARGET) * 1000) / 10, 100);

    return res.json({
      success: true,
      data: { total_amount: sum, total_count: count, target_amount: GOAL_TARGET, percentage: pct }
    });
  } catch (err) {
    res.json({ success: true, data: { total_amount: 0, total_count: 0, target_amount: GOAL_TARGET, percentage: 0 } });
  }
});

/**
 * GET /api/recent-donations
 * รายการผู้สนับสนุนล่าสุด Real-time (ดึงจาก Supabase หรือ in-memory)
 */
app.get('/api/recent-donations', async (req, res) => {
  if (!supabase) {
    // ส่งข้อมูลจริงจาก in-memory (ไม่มี mock data)
    const recentReal = memoryStore.donations
      .filter(d => d.status === 'SUCCESS')
      .slice(0, 10)
      .map(d => ({
        donor_name: d.donor_name,
        message: d.message,
        amount: d.amount,
        created_at: d.created_at
      }));

    return res.json({ success: true, data: recentReal });
  }

  try {
    const { data, error } = await supabase
      .from('donations')
      .select('id, donor_name, message, amount, created_at')
      .eq('status', 'SUCCESS')
      .order('created_at', { ascending: false })
      .limit(10);

    if (error) throw error;
    return res.json({ success: true, data: data || [] });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

/**
 * GET /api/health
 */
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    mode: supabase ? 'supabase' : 'in-memory',
    goal_target: GOAL_TARGET,
    receiver_phone: maskPhone(RECEIVER_PHONE)
  });
});

// ==========================================
// 3. START SERVER
// ==========================================
app.listen(PORT, () => {
  console.log(`
  ======================================================
  🚀 Ibuki TrueMoney Donation API is running!
  📡 Port: ${PORT}
  📱 Receiver Phone: ${maskPhone(RECEIVER_PHONE)}
  🗄️ Supabase: ${Boolean(supabase) ? 'Connected' : 'Offline → In-Memory Storage'}
  📢 Discord Webhook: ${Boolean(DISCORD_WEBHOOK_URL && !DISCORD_WEBHOOK_URL.includes('your-webhook-id')) ? 'Active' : 'Not Set'}
  🎯 Goal Target: ${GOAL_TARGET.toLocaleString()} บาท
  ======================================================
  `);
});
