// MNC टेस्टनेट रिकॉर्ड साइट — कॉन्फ़िग
// यहाँ सिर्फ़ सार्वजनिक (publishable) key रखें। Secret / service_role key
// इस फ़ाइल में कभी न डालें — यह फ़ाइल हर विज़िटर के ब्राउज़र में जाती है।

window.MNC_SITE_CONFIG = {
  supabaseUrl: "https://gaddknalbfgzilndmfyf.supabase.co",
  supabaseKey: "sb_publishable_OUFXENQa8Rl6NR_StPFpKg_dP7vnHOB",
  table: "blocks",

  // जिस पंक्ति में reward / difficulty कॉलम न हो, वहाँ ये मान लिए जाते हैं
  rewardPerBlock: 50,
  defaultDifficulty: 4,
};
