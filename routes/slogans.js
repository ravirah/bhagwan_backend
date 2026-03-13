const express = require('express');
const router = express.Router();
const getModels = require('../models');
const dbFactory = require('../config/database');

router.get('/', async (req, res) => {
  try {
    const { Slogan } = getModels();
    const appId = req.query.appId || 'ram-bank';

    let slogans;
    if (dbFactory.isMongoDB()) {
      slogans = await Slogan.find({ appId }).sort({ createdAt: -1 });
    } else {
      slogans = await Slogan.findAll({
        where: { appId },
        order: [['createdAt', 'DESC']],
      });
    }

    res.json({
      success: true,
      slogans,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message,
    });
  }
});

module.exports = router;
