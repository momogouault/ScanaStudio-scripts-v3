/* Protocol meta info:
<NAME> CAN Bus </NAME>
<DESCRIPTION>
CAN bus protocol analyzer
</DESCRIPTION>
<VERSION> 0.1 </VERSION>
<AUTHOR_NAME>  Ibrahim KAMAL, Nicolas Bastit </AUTHOR_NAME>
<AUTHOR_URL> i.kamal@ikalogic.com, n.bastit@ikalogic.com </AUTHOR_URL>
<HELP_URL> https://github.com/ikalogic/ScanaStudio-scripts-v3/wiki </HELP_URL>
<COPYRIGHT> Copyright Ibrahim KAMAL </COPYRIGHT>
<LICENSE>  This code is distributed under the terms of the GNU General Public License GPLv3 </LICENSE>
<RELEASE_NOTES>
V0.1:  Initial release.
</RELEASE_NOTES>
*/

/*
// TODO: add GUI validation to prohibit incompatible bitrate and sample rate
// TODO: add option to select display format for data/ID, etc..
// TODO: detect errors and reset can_state_machine  to CAN.SEEK_SOF
// TODO: Calculate and Check CRC
*/


//Decoder GUI
function on_draw_gui_decoder()
{
  //Define decoder configuration GUI
  ScanaStudio.gui_add_ch_selector("ch","CAN Channel","CAN");
  ScanaStudio.gui_add_engineering_form_input_box("rate","Bit rate",100,1e6,125e3,"Bit/s");
  ScanaStudio.gui_add_new_tab("Advanced options",true);
    ScanaStudio.gui_add_engineering_form_input_box("rate_fd","CAN-FD bit rate",100,20e6,2e6,"Bit/s");
  ScanaStudio.gui_end_tab();
}

//Global variables
var sampling_rate;
var cursor,prev_cursor;
var state_machine;
var ch,rate,rate_fd;
var margin,margin_fd;
var stuff_mode = 0; //0: off, 1: std bit stuffing, 2: FD CRC bit stuffing
var samples_per_bit,samples_per_bit_std,samples_per_bit_fd,sample_point_offset;
var sample_point_offset_std,sample_point_offset_fd;
var fd_mode = false;
var bit_to_process,current_bit_value,recessive_bits_counter;
var switch_to_high_baud_rate = false;
var switch_to_std_baud_rate = false;
var crc_len = 15;
/*


[Samples]---->[bits]--┯----->[destuff]-------┯---->[process bits]
                      |                      |
                      └----->[CRC_FD calc]   └---->[CRC_STD calc]
*/

function on_decode_signals(resume)
{
  var is_stuffed_bit;
  if (!resume) //If resume == false, it's the first call to this function.
  {
      //initialization code goes here, ex:
      state_machine = 0;
      can_state_machine = CAN.SEEK_SOF;
      cursor = 1;
      sampling_rate = ScanaStudio.get_capture_sample_rate();
      ch = ScanaStudio.gui_get_value("ch");
      rate = ScanaStudio.gui_get_value("rate");
      rate_fd = ScanaStudio.gui_get_value("rate_fd");
      samples_per_bit_std =  Math.floor(sampling_rate / rate);

      //Pinpoint exact sampling point (CAN Spec page 28)
      sample_point_offset_std = Math.floor(samples_per_bit_std *11 / 15);
      samples_per_bit_fd =  Math.floor(sampling_rate / rate_fd);
      samples_per_brs_bit = (samples_per_bit_std*11/15) + (samples_per_bit_fd*4/10);
      samples_per_fd_crc_del_bit = (samples_per_bit_fd*6/10) + (samples_per_bit_std*4/15);
      sample_point_offset_fd = Math.floor(samples_per_bit_fd *6 / 10);
      margin = Math.floor(samples_per_bit_std / 20) + 1;
      margin_fd = Math.floor(samples_per_bit_std / 20) + 1;
      fd_mode = false;
      stuff_mode = 1;
      current_bit_value = 0;
      recessive_bits_counter = 1;
      bit_to_process = 0;
      ScanaStudio.trs_reset(ch);
  }



  while (ScanaStudio.abort_is_requested() == false)
  {
    if (!ScanaStudio.trs_is_not_last(ch))
    {
      break;
    }

    switch (state_machine)
    {
      case 0: //Search for next transition and sync to it.
        trs = ScanaStudio.trs_get_next(ch);
        if (trs.sample_index >= cursor)
        {
          cursor = trs.sample_index;
          if (fd_mode) //Flexible datarate CAN
          {
            //ScanaStudio.console_info_msg("FD resync ",cursor);
            samples_per_bit = samples_per_bit_fd;
            sample_point_offset = sample_point_offset_fd;
            ScanaStudio.bit_sampler_init(ch,cursor+sample_point_offset_fd,samples_per_bit);
            cursor += sample_point_offset_fd;
            //ScanaStudio.console_info_msg("bit sampler initialzed",cursor);
          }
          else  //standard CAN
          {
            //ScanaStudio.console_info_msg("STD resync ",cursor);
            samples_per_bit = samples_per_bit_std;
            sample_point_offset = sample_point_offset_std;
            ScanaStudio.bit_sampler_init(ch,cursor+sample_point_offset_std,samples_per_bit);
            cursor += sample_point_offset_std;
          }
          current_bit_value = trs.value;
          prev_cursor = cursor;
          recessive_bits_counter = 0;
          state_machine++;
        }
        break;
      case 1: //process bits until there is a change
        if (ScanaStudio.get_available_samples(ch) > (cursor + samples_per_bit))
        {
          //ScanaStudio.console_info_msg("fetching bit");
          bit_to_process = ScanaStudio.bit_sampler_next(ch)
          if (bit_to_process == 1)
          {
            if (recessive_bits_counter++ > 6)
            {
              cursor = prev_cursor;
              state_machine = 0;
              fd_mode = false;
              switch_to_high_baud_rate = false;
              switch_to_std_baud_rate = false;
              can_state_machine = CAN.SEEK_SOF;
              //scanastudio.console_info_msg("More than 6 recessive bits, error! ",cursor);
              break;
            }
          }

          if (can_state_machine == CAN.SEEK_SOF)
          {
            stuffing_reset();
            stuff_mode = 1; //By default, normal stuffing
          }

          if (bit_to_process == current_bit_value)
          {
            is_stuffed_bit = false;
            if (stuff_mode == 1)
            {
              if (stuffing_check(bit_to_process) >= 0)
              {
                is_stuffed_bit = true;
              }
            }
            else if (stuff_mode == 2)
            {
              if (stuffing_check_fd_crc(bit_to_process) >= 0)
              {
                is_stuffed_bit = true;
              }
            }
            can_process_bit(bit_to_process,cursor,is_stuffed_bit);
            prev_cursor = cursor;

            if (switch_to_high_baud_rate && (is_stuffed_bit == false))
            {
              //scanastudio.console_info_msg("Switching to high baud rate here! new spb="+samples_per_bit_fd + ", was " + samples_per_bit_std,cursor);
              switch_to_high_baud_rate = false;
              ScanaStudio.bit_sampler_init(ch,cursor+samples_per_bit_fd,samples_per_bit_fd);
              cursor += samples_per_bit_fd;
              //scanastudio.console_info_msg("new cursor pos = " +  cursor,cursor);
              samples_per_bit = samples_per_bit_fd;
              fd_mode = true;
            }
            else if (switch_to_std_baud_rate && (is_stuffed_bit == false))
            {
              //scanastudio.console_info_msg("Switching to standard baud rate here!",cursor);
              switch_to_std_baud_rate = false;
              ScanaStudio.bit_sampler_init(ch,cursor+samples_per_bit_std,samples_per_bit_std);
              cursor += samples_per_bit_std;
              //scanastudio.console_info_msg("new cursor pos = " +  cursor,cursor);
              samples_per_bit = samples_per_bit_std;
              fd_mode = false;
            }
            else
            {
              cursor += samples_per_bit;
            }
          }
          else //CAN line level changed, resync!
          {
            cursor = prev_cursor;
            //ScanaStudio.console_info_msg("bit change at" + cursor,cursor);
            state_machine = 0;
          }
        }
        break;
      default:
        state_machine = 0;
    }
  }
}

var CAN =
{
	SEEK_SOF         : 0,
  SEEK_BASE_ID     : 10,
  SEEK_FD_R0_BRS      : 11,
	SEEK_DLC        : 2,
  SEEK_FD_ESI_DLC    : 30,
  SEEK_DLC_FD2    : 31,
  SEEK_IDE         : 4,
  SEEK_DATA        : 5,
  SEEK_CRC         : 60,
  SEEK_CRC_DEL     : 65,
  SEEK_ACK         :7,
};
var can_state_machine = CAN.SEEK_SOF;
var can_destuffed_bit_counter = 0; //count real bit (discarding stuffed bits)
var can_bits = [];
var can_byte_counter;
var can_base_id;
var is_can_fd_frame;
var is_fd_mode;
function can_process_bit(b,sample_point,is_stuffed_bit)
{
  var i;
  //TODO: don't calculate CRC on CRC field
  //TODO append bit to CAN FD crc calculator here
  if (is_stuffed_bit)
  {
    can_bits.push([sample_point,"X",b]);
    //scanastudio.console_info_msg("+1 stuffed bit at " + sample_point,sample_point);
    return;
  }
  can_bits.push([sample_point,"U",b]);
  //ScanaStudio.console_info_msg( b +" bit",sample_point);
  //TODO append bit to std crc calculator here
  switch (can_state_machine) {
    case CAN.SEEK_SOF: //Seek SOF
      if (b == 0)
      {
        //ScanaStudio.console_info_msg("sample_point",sample_point);
        //ScanaStudio.console_info_msg("sample_point_offset_std = " + sample_point_offset_std);
        //Add start bit item
        ScanaStudio.dec_item_new( ch,
                                  sample_point - sample_point_offset_std,
                                  sample_point - sample_point_offset_std + samples_per_bit_std);
        ScanaStudio.dec_item_add_content("Start Of Frame");
        ScanaStudio.dec_item_add_content("SOF");
        ScanaStudio.dec_item_add_content("S");
        ScanaStudio.dec_item_add_sample_point(sample_point,"U");
        can_bits = [];
        can_state_machine = CAN.SEEK_BASE_ID;
        is_can_fd_frame = false;
        is_fd_mode = false;
        crc_len = 15;
        can_destuffed_bit_counter = 0;
      }
      break;
    case CAN.SEEK_BASE_ID: //and also R1, IDE and R0
      can_destuffed_bit_counter++;
      if (can_destuffed_bit_counter == 14)
      {
        can_destuffed_bit_counter = 0;
        can_base_id = interpret_can_bits(can_bits,0,11);
        can_rtr_r1 = interpret_can_bits(can_bits,11,1);
        can_ide = interpret_can_bits(can_bits,12,1);
        can_r0 = interpret_can_bits(can_bits,13,1);


        //Base ID field
        ScanaStudio.dec_item_new( ch,
                                  can_base_id.start - sample_point_offset_std,
                                  can_base_id.end - sample_point_offset_std + samples_per_bit_std);
        ScanaStudio.dec_item_add_content("Base ID = 0x" + can_base_id.value.toString(16));
        ScanaStudio.dec_item_add_content("0x" + can_base_id.value.toString(16));
        add_can_bits_sampling_points(can_bits,0,11);

        //RTR / R1 field
        ScanaStudio.dec_item_new( ch,
                                    can_rtr_r1.start - sample_point_offset_std,
                                    can_rtr_r1.end - sample_point_offset_std + samples_per_bit_std);
        add_can_bits_sampling_points(can_bits,11,1);
        if (can_ide.value == 0)
        {
          if (can_r0.value == 0)
          {
            ScanaStudio.dec_item_add_content("RTR");
            can_state_machine = CAN.SEEK_DLC;
          }
          else
          {
            is_can_fd_frame = true;
            ScanaStudio.dec_item_add_content("R1");
            can_state_machine = CAN.SEEK_FD_R0_BRS;
          }
        }
        else
        {
          ScanaStudio.dec_item_add_content("SRR");
          can_state_machine = CAN.SEEK_IDE;
        }

        //IDE Field
        ScanaStudio.dec_item_new( ch,
                                    can_ide.start - sample_point_offset_std,
                                    can_ide.end - sample_point_offset_std + samples_per_bit_std);
        add_can_bits_sampling_points(can_bits,12,1);
        ScanaStudio.dec_item_add_content("IDE = " + can_ide.value.toString());
        ScanaStudio.dec_item_add_content("IDE");

        //R0 - EDL (if not IDE)
        if (can_state_machine != CAN.SEEK_IDE)
        {
          ScanaStudio.dec_item_new( ch,
          can_r0.start - sample_point_offset_std,
          can_r0.end - sample_point_offset_std + samples_per_bit_std);
          if (can_r0.value == 0)
          {
            ScanaStudio.dec_item_add_content("R0 = " + can_r0.value.toString());
            ScanaStudio.dec_item_add_content("R0");
          }
          else
          {
            ScanaStudio.dec_item_add_content("EDL = " + can_r0.value.toString());
            ScanaStudio.dec_item_add_content("EDL");
          }
          add_can_bits_sampling_points(can_bits,13,1);

          can_bits = [];
        }
        else //It's a IDE frame, RO/EDL need to be counted in the IDE
        {
          can_destuffed_bit_counter = 1;
          can_bits = can_bits.slice(can_bits.length-1);
        }
      }
      break;
    case CAN.SEEK_IDE:
      can_destuffed_bit_counter++;
      if (can_destuffed_bit_counter == 21)
      {

        can_id_ext = interpret_can_bits(can_bits,0,18);
        can_full_id = (can_base_id.value << 18) | can_id_ext.value;
        can_rtr_r1 = interpret_can_bits(can_bits,18,1);
        can_r1_edl = interpret_can_bits(can_bits,19,1);
        can_r0 = interpret_can_bits(can_bits,20,1);

        //Base ID field
        ScanaStudio.dec_item_new( ch,
                                  can_id_ext.start - sample_point_offset_std,
                                  can_id_ext.end - sample_point_offset_std + samples_per_bit_std);
        ScanaStudio.dec_item_add_content("Full Extended ID = 0x" + can_full_id.toString(16) + " (" + can_base_id.value.toString(16) + " + " + can_id_ext.value.toString(16) + ")");
        ScanaStudio.dec_item_add_content("Full ID = 0x" + can_full_id.toString(16));
        ScanaStudio.dec_item_add_content("0x"+can_full_id.toString(16));
        ScanaStudio.dec_item_add_content("ID Ext.");
        add_can_bits_sampling_points(can_bits,0,18);

        if (can_r1_edl.value == 0) //CAN Frame
        {
          //RTR
          ScanaStudio.dec_item_new( ch,
                                    can_rtr_r1.start - sample_point_offset_std,
                                    can_rtr_r1.end - sample_point_offset_std + samples_per_bit_std);
          add_can_bits_sampling_points(can_bits,18,1);
          ScanaStudio.dec_item_add_content("RTR = " + can_rtr_r1.value.toString());
          ScanaStudio.dec_item_add_content("RTR");
          //R1
          ScanaStudio.dec_item_new( ch,
                                    can_r1_edl.start - sample_point_offset_std,
                                    can_r1_edl.end - sample_point_offset_std + samples_per_bit_std);
          add_can_bits_sampling_points(can_bits,19,1);
          ScanaStudio.dec_item_add_content("R1 = " + can_r1_edl.value.toString());
          ScanaStudio.dec_item_add_content("R1");
        }
        else //CAN FD frame
        {
          is_can_fd_frame = true;
          //R1
          ScanaStudio.dec_item_new( ch,
                                    can_rtr_r1.start - sample_point_offset_std,
                                    can_rtr_r1.end - sample_point_offset_std + samples_per_bit_std);
          add_can_bits_sampling_points(can_bits,18,1);
          ScanaStudio.dec_item_add_content("R1 = " + can_rtr_r1.value.toString());
          ScanaStudio.dec_item_add_content("R1");
          //EDL
          ScanaStudio.dec_item_new( ch,
                                    can_r1_edl.start - sample_point_offset_std,
                                    can_r1_edl.end - sample_point_offset_std + samples_per_bit_std);
          add_can_bits_sampling_points(can_bits,19,1);
          ScanaStudio.dec_item_add_content("EDL = " + can_r1_edl.value.toString());
          ScanaStudio.dec_item_add_content("EDL");
        }

        //R0
        ScanaStudio.dec_item_new( ch,
                                  can_r0.start - sample_point_offset_std,
                                  can_r0.end - sample_point_offset_std + samples_per_bit_std);
        add_can_bits_sampling_points(can_bits,20,1);
        ScanaStudio.dec_item_add_content("R0 = " + can_r0.value.toString());
        ScanaStudio.dec_item_add_content("R0");

        if (is_can_fd_frame)
        {
          can_state_machine = CAN.SEEK_FD_R0_BRS;
          can_destuffed_bit_counter = 1;
          can_bits = can_bits.slice(can_bits.length-1);
        }
        else
        {
          can_state_machine = CAN.SEEK_DLC;
          can_destuffed_bit_counter = 0;
          can_bits = [];
        }
      }
      break;
    case CAN.SEEK_DLC:
      can_destuffed_bit_counter++;
      if (can_destuffed_bit_counter == 4)
      {
        can_destuffed_bit_counter = 0;
        can_dlc = interpret_can_bits(can_bits,0,4);
        can_len = can_dlc.value;
        if (can_len > 8) can_len = 8;

        ScanaStudio.dec_item_new( ch,
                                  can_dlc.start - sample_point_offset_std,
                                  can_dlc.end - sample_point_offset_std + samples_per_bit_std);
        ScanaStudio.dec_item_add_content("DLC = " + can_dlc.value.toString());
        ScanaStudio.dec_item_add_content(can_dlc.value.toString());
        add_can_bits_sampling_points(can_bits,0,4);

        can_state_machine = CAN.SEEK_DATA;
        can_byte_counter = 0;
        can_bits = [];
      }
      break;
    case CAN.SEEK_FD_R0_BRS:
      can_destuffed_bit_counter++;
      if (can_destuffed_bit_counter == 2)
      {
        can_destuffed_bit_counter = 0;
        can_r0 = interpret_can_bits(can_bits,0,1);
        can_brs = interpret_can_bits(can_bits,1,1);

        ScanaStudio.dec_item_new( ch,
                                can_r0.start - sample_point_offset_std,
                                can_r0.end - sample_point_offset_std + samples_per_bit_std);
        ScanaStudio.dec_item_add_content("R0");
        add_can_bits_sampling_points(can_bits,0,1);

        if (can_brs.value == 1)
        {
          ScanaStudio.dec_item_new( ch,
                                    can_brs.start - sample_point_offset_std,
                                    can_brs.end - sample_point_offset_std + samples_per_brs_bit);
          ScanaStudio.dec_item_add_content("BRS = 1 (Switching bit rate)");
          ScanaStudio.dec_item_add_content("BRS = 1");
          //scanastudio.console_info_msg("Switching to high bit rate on next bit, at cursor = " + sample_point,sample_point);
          switch_to_high_baud_rate = true;
          is_fd_mode = true;
          samples_per_bit = samples_per_bit_fd;
          sample_point_offset = sample_point_offset_fd;
        }
        else
        {
          ScanaStudio.dec_item_new( ch,
                                    can_brs.start - sample_point_offset_std,
                                    can_brs.end - sample_point_offset_std + samples_per_bit_std);
          ScanaStudio.dec_item_add_content("BRS = 0 (No bitrate switch)");
          ScanaStudio.dec_item_add_content("BRS = 0");
        }
        add_can_bits_sampling_points(can_bits,1,1);
        can_bits = [];
        can_state_machine = CAN.SEEK_FD_ESI_DLC;
      }
      break;
    case CAN.SEEK_FD_ESI_DLC:
      //ScanaStudio.console_info_msg("TP, can_bits len= " + can_bits.length,sample_point);
      can_destuffed_bit_counter++;
      if (can_destuffed_bit_counter == 5)
      {
        can_destuffed_bit_counter = 0;
        can_esi = interpret_can_bits(can_bits,0,1);
        can_dlc = interpret_can_bits(can_bits,1,4);
        can_len = get_data_len(can_dlc.value);
        /*switch (can_len) {
          case 9:
            can_len = 12;
            break;
          case 10:
            can_len = 16;
            break;
          case 11:
            can_len = 20;
            break;
          case 12:
            can_len = 24;
            break;
          case 13:
            can_len = 32;
            break;
          case 14:
            can_len = 48;
            break;
          case 15:
            can_len = 64;
            break;
          default:
        }*/

        ScanaStudio.dec_item_new( ch,
                                  can_esi.start - sample_point_offset,
                                  can_esi.end - sample_point_offset + samples_per_bit);
        ScanaStudio.dec_item_add_content("ESI = " + can_esi.value.toString());
        ScanaStudio.dec_item_add_content("ESI");
        if (can_esi.value == 0)
        {
          ScanaStudio.dec_item_emphasize_warning();
        }
        add_can_bits_sampling_points(can_bits,0,1);

        ScanaStudio.dec_item_new( ch,
                                  can_dlc.start - sample_point_offset,
                                  can_dlc.end - sample_point_offset + samples_per_bit);
        ScanaStudio.dec_item_add_content("DLC = " + can_dlc.value.toString() + ", Data length = " + can_len.toString());
        ScanaStudio.dec_item_add_content("Length = " + can_len.toString());
        ScanaStudio.dec_item_add_content(can_len.toString());
        add_can_bits_sampling_points(can_bits,1,4);

        can_state_machine = CAN.SEEK_DATA;
        can_byte_counter = 0;
        crc_len = crc_get_len(can_len);
        can_bits = [];
      }
      break;
    case CAN.SEEK_DATA:
      can_destuffed_bit_counter++;
      if (can_destuffed_bit_counter == 8)
      {
        can_destuffed_bit_counter = 0;
        can_data = interpret_can_bits(can_bits,0,8);

        ScanaStudio.dec_item_new( ch,
                                  can_data.start - sample_point_offset,
                                  can_data.end - sample_point_offset + samples_per_bit);
        ScanaStudio.dec_item_add_content("DATA = 0x" + can_data.value.toString(16));
        ScanaStudio.dec_item_add_content("0x" + can_data.value.toString(16));
        ScanaStudio.dec_item_add_content(can_data.value.toString(16));
        add_can_bits_sampling_points(can_bits,0,8);
        can_byte_counter++;
        can_bits = [];
        if (can_byte_counter >= can_len)
        {
          if (is_can_fd_frame)
          {
            stuff_mode = 2;
          }
          else
          {
            stuff_mode = 0;
          }
          can_state_machine = CAN.SEEK_CRC;
          can_destuffed_bit_counter = 0;
        }
      }
      break;
    case CAN.SEEK_CRC:
      //scanastudio.console_info_msg("TP, CRC bits len= " + can_bits.length + ", " + can_destuffed_bit_counter + "/" + crc_len,sample_point);
      can_destuffed_bit_counter++;
      if (can_destuffed_bit_counter == crc_len)
      {
        can_destuffed_bit_counter = 0;
        can_crc = interpret_can_bits(can_bits,0,crc_len);

        ScanaStudio.dec_item_new( ch,
                                  can_crc.start - sample_point_offset,
                                  can_crc.end - sample_point_offset + samples_per_bit);
        ScanaStudio.dec_item_add_content("CRC = 0x" + can_crc.value.toString(16));
        ScanaStudio.dec_item_add_content("0x" + can_crc.value.toString(16));
        ScanaStudio.dec_item_add_content(can_crc.value.toString(16));
        add_can_bits_sampling_points(can_bits,0,crc_len);
        can_bits = [];
        can_state_machine = CAN.SEEK_CRC_DEL;
        stuff_mode = 0; //No more bit stuffing after this point (even for CAN FD)
      }
      break;
    case CAN.SEEK_CRC_DEL: //CRC Delimiter, this is also where we switch back from FD mode to std bitrate
      can_destuffed_bit_counter++;
      if (can_destuffed_bit_counter == 1)
      {
        can_destuffed_bit_counter = 0;
        can_crc_del = interpret_can_bits(can_bits,0,1);
        //CRC Delimiter
        if (is_fd_mode)
        {
          ScanaStudio.dec_item_new( ch,
                                    can_crc_del.start - sample_point_offset,
                                    can_crc_del.end - sample_point_offset + samples_per_fd_crc_del_bit);
        }
        else
        {
          ScanaStudio.dec_item_new( ch,
                                    can_crc_del.start - sample_point_offset_std,
                                    can_crc_del.end - sample_point_offset_std + samples_per_bit_std);
        }

        if (can_crc_del.value == 1)
        {
          ScanaStudio.dec_item_add_content("CRC Delimiter");
          ScanaStudio.dec_item_add_content("CRC Del.");
          ScanaStudio.dec_item_add_content("Del.");
          ScanaStudio.dec_item_add_content("D");
        }
        else
        {
          ScanaStudio.dec_item_add_content("CRC Delimiter missing");
          ScanaStudio.dec_item_add_content("!CRC Del.");
          ScanaStudio.dec_item_add_content("!Del.");
          ScanaStudio.dec_item_emphasize_error();
        }
        add_can_bits_sampling_points(can_bits,0,1);
        if (is_fd_mode)
        {
          //scanastudio.console_info_msg("Switching back to std bitrate",sample_point);
          switch_to_std_baud_rate = true;
        }
        can_bits = [];
        can_state_machine = CAN.SEEK_ACK;
      }
      break;
    case CAN.SEEK_ACK: //ACK, DEL, EOF //TODO: rename this to "EOF_BITS", not just "ACK"
      can_destuffed_bit_counter++;
      if (can_destuffed_bit_counter == 3)
      {
        can_destuffed_bit_counter = 0;

        can_ack = interpret_can_bits(can_bits,0,1);
        can_ack_del = interpret_can_bits(can_bits,1,1);
        can_eof = interpret_can_bits(can_bits,2,1);



        //ACK
        ScanaStudio.dec_item_new( ch,
                                  can_ack.start - sample_point_offset_std,
                                  can_ack.end - sample_point_offset_std + samples_per_bit_std);
        if (can_ack.value == 0)
        {
          ScanaStudio.dec_item_add_content("Acknowledge");
          ScanaStudio.dec_item_add_content("ACK");
          ScanaStudio.dec_item_add_content("A");
        }
        else
        {
          ScanaStudio.dec_item_add_content("No Acknowledge");
          ScanaStudio.dec_item_add_content("NO ACK");
          ScanaStudio.dec_item_add_content("!A");
          ScanaStudio.dec_item_emphasize_warning();
        }
        add_can_bits_sampling_points(can_bits,0,1);

        //ACK DEL
        ScanaStudio.dec_item_new( ch,
                                  can_ack_del.start - sample_point_offset_std,
                                  can_ack_del.end - sample_point_offset_std + samples_per_bit_std);
        if (can_ack_del.value == 1)
        {
          ScanaStudio.dec_item_add_content("Acknowledge Delimiter");
          ScanaStudio.dec_item_add_content("ACK Del.");
          ScanaStudio.dec_item_add_content("Del.");
          ScanaStudio.dec_item_add_content("D");
        }
        else
        {
          ScanaStudio.dec_item_add_content("ACK Delimiter missing");
          ScanaStudio.dec_item_add_content("!ACK Del.");
          ScanaStudio.dec_item_add_content("!Del.");
          ScanaStudio.dec_item_emphasize_error();
        }
        add_can_bits_sampling_points(can_bits,1,1);

        //EOF
        ScanaStudio.dec_item_new( ch,
                                  can_eof.start - sample_point_offset_std,
                                  can_eof.end - sample_point_offset_std + samples_per_bit_std);
        if (can_eof.value == 1)
        {
          ScanaStudio.dec_item_add_content("End of Frame");
          ScanaStudio.dec_item_add_content("EOF");
          ScanaStudio.dec_item_add_content("E");
        }
        else
        {
          ScanaStudio.dec_item_add_content("EOF missing");
          ScanaStudio.dec_item_add_content("!EOF");
          ScanaStudio.dec_item_add_content("!E");
          ScanaStudio.dec_item_emphasize_error();
        }
        add_can_bits_sampling_points(can_bits,2,1);

        can_bits = [];
        can_state_machine = CAN.SEEK_SOF;
        fd_mode = false;
        switch_to_high_baud_rate = false;
        switch_to_std_baud_rate = false;
      }
    default:
  }
}

/*
  Start and n_bits are expressed in terms of destuffed bits
  returns a can_field() object
*/
function interpret_can_bits(can_bits_array,start,n_bits)
{
  var i,db_cnt,len;
  var ret = new can_field();
  db_cnt = len = 0;
  ret.value = 0
  for (i = 0; i < can_bits.length; i++)
  {
    if (can_bits[i][1] != "X")
    {
      if (db_cnt == start)
      {
        ret.start = can_bits[i][0];
      }
      if (db_cnt >= start)
      {
        ret.value = (ret.value * 2) + can_bits[i][2];
        len++;
      }
      db_cnt++;
      if (len >= n_bits)
      {
        ret.end = can_bits[i][0];
        break;
      }
    }
  }
  return ret;
}

/*
  Start and n_bits are expressed in terms of destuffed bits
*/
function add_can_bits_sampling_points(can_bits_array,start,n_bits)
{
  var i,db_cnt,len;
  db_cnt = len = 0;
  for (i = 0; i < can_bits_array.length; i++)
  {
    if (can_bits[i][1] != "X")
    {
      if (db_cnt >= start)
      {
        len++;
      }
      db_cnt++;
    }
    if (db_cnt > start)
    {
      ScanaStudio.dec_item_add_sample_point(can_bits_array[i][0],can_bits_array[i][1]);
    }
    if (len >= n_bits)
    {
      break;
    }
  }
}

function can_field()
{
  this.value = 0;
  this.start = 0;
  this.end = 0;
}

//Function called to generate demo siganls (when no physical device is attached)
function on_build_demo_signals()
{
  //Use the function below to get the number of samples to be built
  var samples_to_build = ScanaStudio.builder_get_maximum_samples_count();
  sampling_rate = ScanaStudio.get_capture_sample_rate();
  var builder = ScanaStudio.BuilderObject;

  builder.configure(0,125e3,2e6,sampling_rate);
  builder.put_silence(1e3);
  //builder.put_can_frame(0x1,[1,2,3]);
  builder.put_can_frame(0x0202,[0x23,0x24,0x25,0x26,0x29,0x30,0x0,0x0]);
  builder.put_silence(1e3);
  //builder.put_can_ext_frame(0x5500AA,[0x23,0x24,0x25,0x26,0x29,0x30,0x0,0x0]);
  builder.put_can_fd_frame(0x0202,[0x23,0x24,0x25,0x26,0x29,0x30,0x0,0x0]);
  builder.put_silence(1e3);
  builder.put_can_fd_ext_frame(0x0202,[0x23,0x24,0x25,0x26,0x29,0x30,0x0,0x0,0x23,0x24,0x25,0x26,0x29,0x30,0x0,0x0,0x23,0x24,0x25,0x26]);
}



//Builder object that can be shared to other scripts
ScanaStudio.BuilderObject = {
  //to be configured by the user of this object using the setter functions below
  channel: 0,
  sampling_rate: 1e6,
	put_can_frame : function(id,data_array)
  {
    var i,crc;
    //ScanaStudio.console_info_msg("put_can_frame, data len = "+data_array.length);
    stuffing_reset();
    crc_reset();
    this.stuffing_mode(1); //Standard bit stuffing
    this.bitrate_std(); //Ensure we use standard bit rate
    this.put_bit(0); //SOF
    this.put_word(id,11)
    if (data_array.length > 0)
    {
        this.put_bit(0); //RTR
    }
    else
    {
      this.put_bit(1); //RTR
    }
    this.put_bit(0); //IDE = 0
    this.put_bit(0); //R0 //Always 0 for CAN frame (1 for CAN FD frames)
    this.put_word(data_array.length,4);
    for (i = 0; i < data_array.length; i++)
    {
      this.put_word(data_array[i],8);
    }
    crc = crc_calc(crc_bits_destuffed,15);
    this.stuffing_mode(0); //Switch off bit stuffing starting from here. (no stuff in CRC)
    this.put_word(crc,15); //CRC
    this.put_bit(1); //CRC DEL
    this.put_bit(0); //ACK
    this.put_bit(1); //ACK DEL
  },
  put_can_fd_frame : function(id,data_array)
  {
    var i,crc;
    //ScanaStudio.console_info_msg("put_can_frame, data len = "+data_array.length);
    stuffing_reset();
    crc_reset();
    this.stuffing_mode(1); //Standard bit stuffing
    this.bitrate_std(); //Ensure we use standard bit rate
    this.put_bit(0); //SOF
    this.put_word(id,11)
    this.put_bit(0); //R1
    this.put_bit(0); //IDE = 0
    this.put_bit(1); //EDL
    this.put_bit(0); //R0
    this.put_brs_bit(1);
    this.bitrate_fd(); //Switch to FD bitrate
    this.put_bit(1); //ESI
    this.put_word( get_dlc(data_array.length) ,4);
    for (i = 0; i < data_array.length; i++)
    {
      this.put_word(data_array[i],8);
    }
    crc = crc_calc(crc_bits_all,crc_get_len(data_array.length));
    this.stuffing_mode(2); //Switch to stuffing mode 2 (stuff in CRC)
    this.put_word(crc,crc_get_len(data_array.length)); //CRC
    this.put_fd_crc_del(1); //CRC DEL
    this.bitrate_std(); //Switch back to standard bit rate
    this.put_bit(0); //ACK
    this.put_bit(1); //ACK DEL
  },
  put_can_ext_frame : function(id,data_array)
  {
    var i,crc;
    //ScanaStudio.console_info_msg("put_can_ext_frame, data len = "+data_array.length);
    stuffing_reset();
    crc_reset();
    this.stuffing_mode(1); //Standard bit stuffing
    this.bitrate_std(); //Ensure we use standard bit rate
    this.put_bit(0); //SOF
    //ScanaStudio.console_info_msg("base id="+((id >> 18) & 0x7FF));
    this.put_word((id >> 18) ,11);
    this.put_bit(1); //SRR
    this.put_bit(1); //IDE = 1
    this.put_word((id) & 0x3FFFF,18);
    if (data_array.length > 0)
    {
        this.put_bit(0); //RTR
    }
    else
    {
      this.put_bit(1); //RTR
    }
    this.put_bit(0); //R1
    this.put_bit(0); //R0 //Always 0 for CAN frame (1 for CAN FD frames)
    this.put_word(data_array.length,4);
    for (i = 0; i < data_array.length; i++)
    {
      this.put_word(data_array[i],8);
    }
    crc = crc_calc(crc_bits_destuffed,15);
    this.stuffing_mode(0); //Switch off bit stuffing starting from here (no stuff in CRC)
    this.put_word(crc,15); //CRC
    this.put_bit(1); //CRC DEL
    this.put_bit(0); //ACK
    this.put_bit(1); //ACK DEL
  },
  put_can_fd_ext_frame : function(id,data_array)
  {
    var i,crc;
    //ScanaStudio.console_info_msg("put_can_ext_frame, data len = "+data_array.length);
    stuffing_reset();
    crc_reset();
    this.stuffing_mode(1); //Standard bit stuffing
    this.bitrate_std(); //Ensure we use standard bit rate
    this.put_bit(0); //SOF
    this.put_word((id >> 18) ,11);
    this.put_bit(1); //SRR
    this.put_bit(1); //IDE = 1
    this.put_word((id) & 0x3FFFF,18);
    this.put_bit(0); //R1
    this.put_bit(1); //EDL
    this.put_bit(0); //R0
    this.put_brs_bit(1);
    this.bitrate_fd(); //Switch to FD bitrate
    this.put_bit(1); //ESI
    this.put_word( get_dlc(data_array.length) ,4); //DLC
    for (i = 0; i < data_array.length; i++)
    {
      this.put_word(data_array[i],8);
    }
    crc = crc_calc(crc_bits_all,crc_get_len(data_array.length));
    this.stuffing_mode(2); //Switch to stuffing mode 2 (stuff in CRC)
    this.put_word(crc,crc_get_len(data_array.length)); //CRC
    this.put_fd_crc_del(1); //CRC DEL
    this.bitrate_std(); //Switch back to standard bit rate
    this.put_bit(0); //ACK
    this.put_bit(1); //ACK DEL
  },
  put_word : function(words,len)
  {
    var i;
    //ScanaStudio.console_info_msg("****** putting word: 0x" + words.toString(16)+", len = "+len);
    for (i = (len-1); i >= 0; i--)
    {
      this.put_bit((words >> i) & 0x1);
    }
  },
  put_silence : function(samples)
  {
    ScanaStudio.builder_add_samples(this.channel,1,samples);
  },
  put_bit : function(b)
  {
    var sb = -1; //assume there is not bit stuffing
    if (this.stuffing == 1)
    {
      sb = stuffing_check(b);
    }
    else if (this.stuffing == 2)
    {
      sb = stuffing_build_fd_crc(b);
    }
    if (sb >= 0) //add stuffed bit if needed
    {
      //ScanaStudio.console_info_msg("Adding stuffed bit " + sb);
      crc_acc(sb,true);
      ScanaStudio.builder_add_samples(this.channel,sb,this.samples_per_bit);
    }
    //ScanaStudio.console_info_msg("Adding " + b);
    crc_acc(b,false);
    ScanaStudio.builder_add_samples(this.channel,b,this.samples_per_bit);
  },
  put_brs_bit : function(b) //Baud rate switch
  {
    var sb = -1; //assume there is not bit stuffing
    if (this.stuffing == 1)
    {
      sb = stuffing_check(b);
    }
    else if (this.stuffing == 2)
    {
      sb = stuffing_build_fd_crc(b);
    }
    if (sb >= 0) //add stuffed bit if needed
    {
      crc_acc(sb,true);
      ScanaStudio.builder_add_samples(this.channel,sb,this.samples_per_bit);
    }
    crc_acc(b,false);
    ScanaStudio.builder_add_samples(this.channel,b,this.samples_per_brs_bit);
  },
  put_fd_crc_del : function(b) //CRC delimiter for CAN FD frame, when baud rate is switched back
  {
    var sb = -1; //assume there is not bit stuffing
    if (this.stuffing == 1)
    {
      sb = stuffing_check(b);
    }
    else if (this.stuffing == 2)
    {
      sb = stuffing_build_fd_crc(b);
    }
    if (sb >= 0) //add stuffed bit if needed
    {
      crc_acc(sb,true);
      ScanaStudio.builder_add_samples(this.channel,sb,this.samples_per_bit);
    }
    crc_acc(b,false);
    ScanaStudio.builder_add_samples(this.channel,b,this.samples_per_fd_crc_del_bit);
  },
  stuffing_mode : function (m) // 0=Off (for default CRC), 1= Normal stuffing, 2= CRC FD stuffing
  {
    this.stuffing = m;
  },
  bitrate_std : function()
  {
    this.samples_per_bit = this.samples_per_bit_std;
  },
  bitrate_fd : function()
  {
    this.samples_per_bit = this.samples_per_bit_fd;
  },
  configure : function(channel,bitrate_std,bitrate_fd,sample_rate)
  {
    this.channel = channel;
    this.samples_per_bit_std = sample_rate/bitrate_std;
    this.samples_per_bit_fd = sample_rate/bitrate_fd;
    this.samples_per_brs_bit = (this.samples_per_bit_std*11/15) + (this.samples_per_bit_fd*4/10);
    this.samples_per_fd_crc_del_bit = (this.samples_per_bit_fd*6/10) + (this.samples_per_bit_std*4/15);
    //ScanaStudio.console_info_msg("samples_per_brs_bit = " + this.samples_per_brs_bit);
    this.bitrate_std();
  }
};

/******************************************
          /Helper functions/
******************************************/

/**
Check if next bit should be a stuffed bit.
returns the stuffed bit value (0 or 1) if a suffed bit is needed
returns -1 if no bit stuff is needed
*/
var stuff_counter = 0;
var stuff_crc_counter = 0;
var stuff_last_bit;
var stuff_first_crc_bit = true;
function stuffing_check(b)
{
  var ret = -1;
  stuff_counter++;
  if (stuff_counter >= 5)
  {
    ret =  (!stuff_last_bit) & 0x1;
    stuff_counter = 0;
  }
  if (b != stuff_last_bit)
  {
    stuff_counter = 0;
  }
  stuff_last_bit = b;
  return ret;
}

/**
Same as check_stuffing but for the CRC field of CAN FD frames
where different stuffing rules applies
*/
function stuffing_build_fd_crc(b)
{
  var ret = -1;
  stuff_crc_counter++;
  //ScanaStudio.console_info_msg("FD CRC stuff_crc_counter="+stuff_crc_counter);
  if ((stuff_crc_counter >= 4) || (stuff_first_crc_bit))
  {
    //ScanaStudio.console_info_msg("FD CRC stuffed bit detected, stuff_crc_counter="+stuff_crc_counter);
    ret =  (!stuff_last_bit) & 0x1;
    stuff_crc_counter = 0;
    stuff_first_crc_bit = false;
  }

  stuff_last_bit = b;
  return ret;
}

function stuffing_check_fd_crc(b)
{
  var ret = -1;
  stuff_crc_counter++;
  //ScanaStudio.console_info_msg("FD CRC stuff_crc_counter="+stuff_crc_counter);
  if ((stuff_crc_counter >= 5) || (stuff_first_crc_bit))
  {
    //ScanaStudio.console_info_msg("FD CRC stuffed bit detected, stuff_crc_counter="+stuff_crc_counter);
    ret =  (!stuff_last_bit) & 0x1;
    stuff_crc_counter = 0;
    stuff_first_crc_bit = false;
  }

  stuff_last_bit = b;
  return ret;
}

function stuffing_reset()
{
  //ScanaStudio.console_info_msg("Stuffing reset");
  stuff_crc_counter = 0;
  stuff_counter = 0;
  stuff_first_crc_bit = true;
  stuff_last_bit = -1; //improbable value, to ensure next bit resets the stuffing counter
}

// CRC function
var crc_bits_destuffed = [];
var crc_bits_all = [];
function crc_reset()
{
  crc_bits_destuffed = [];
  crc_bits_all = [];
}

function crc_acc(b,is_stuffed_bit)
{
  b = Number(b);
  if (is_stuffed_bit == false)
  {
      crc_bits_destuffed.push(b);
      crc_bits_all.push(b);
  }
  else
  {
    crc_bits_all.push(b);
  }
}

function crc_get_len(n_data_bytes)
{
  var len;
  if (n_data_bytes > 16)
  {
    len = 21;
  }
  else
  {
    len = 17;
  }
  return len;
}

function crc_calc(bits,crc_len)
{
  var crc_nxt;
  var crc = 0;
  var b = 0;
  var poly;
  switch (crc_len) {
    case 17:
      poly = 0x3685B;
      break;
    case 21:
      poly = 0x302899;
      break;
    default:
      poly = 0xC599;
  }
  /*for (b = 0; b < crc_len; b++)
  {
    bits.push(0);
  }*/
  //ScanaStudio.console_info_msg("CRC debug, bits len = " + bits.length);
  bits_sequence = "";
  for (b = 0; b < bits.length; b++)
  {
    bits_sequence += bits[b].toString();
    crc_nxt = bits[b] ^ ((crc >> (crc_len-1))&0x1);
    crc = crc << 1;
    crc &= 0xFFFE;
    if (crc_nxt == 1)
    {
      crc = (crc ^ (poly & ~(1 << (crc_len))))
      //TODO: can't we just write crc = (crc ^ poly) ?
    }
    crc &= 0x7fff;
  }
  //ScanaStudio.console_info_msg("seq="+bits_sequence);
  //ScanaStudio.console_info_msg("crc="+crc.toString(16));
  return crc;
}

function get_data_len(dlc_code)
{
  var can_len;
  switch (dlc_code) {
          case 9:
            can_len = 12;
            break;
          case 10:
            can_len = 16;
            break;
          case 11:
            can_len = 20;
            break;
          case 12:
            can_len = 24;
            break;
          case 13:
            can_len = 32;
            break;
          case 14:
            can_len = 48;
            break;
          case 15:
            can_len = 64;
            break;
          default:
            can_len = dlc_code;
        }
  return can_len;
}

function get_dlc(data_len)
{
  var dlc;
  if (data_len <= 8)
  {
    dlc = data_len;
  }
  else if (data_len == 12)
  {
    dlc = 9;
  }
  else if (data_len == 16)
  {
    dlc = 10;
  }
  else if (data_len == 20)
  {
    dlc = 11;
  }
  else if (data_len == 14)
  {
    dlc = 12;
  }
  else if (data_len == 32)
  {
    dlc = 13;
  }
  else if (data_len == 48)
  {
    dlc = 14;
  }
  else
  {
    dlc = 15;
  }

  return dlc;
}